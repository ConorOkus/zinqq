---
title: 'feat: Add esplora request batching and caching'
type: feat
status: completed
date: 2026-04-07
origin: docs/brainstorms/2026-04-07-esplora-request-batching-brainstorm.md
---

# feat: Add esplora request batching and caching

## Overview

The app is getting rate limited (HTTP 429, connection refused, CORS blocks) on mainnet esplora servers (blockstream.info, mempool.space). A prior optimization effort (doubled LDK interval to 60s, tripled BDK to 180s, consolidated fee cache) reduced overall volume but didn't eliminate burst-induced rate limiting.

The core problem is unbounded parallelism: the LDK chain sync fires all watched txid/output checks simultaneously via `Promise.allSettled` with no concurrency limit, creating request bursts that trigger rate limiting.

## Problem Statement / Motivation

With active channels, each LDK sync tick (every 60s) can fire N concurrent requests per watched txid/output. Multiple watched items confirmed in the same block redundantly fetch the same block header. There is no request deduplication or caching. BDK's parallel requests (set to 5) compound the issue when its 180s sync overlaps with LDK's 60s sync.

(see brainstorm: `docs/brainstorms/2026-04-07-esplora-request-batching-brainstorm.md`)

## Proposed Solution

Add a fetch middleware layer inside the LDK `EsploraClient` class with three capabilities:

1. **Concurrency limiter** (semaphore, max 2 parallel HTTP requests)
2. **In-flight request deduplication** (coalesce identical concurrent fetches)
3. **LRU cache for immutable responses** (block headers, tx hex, merkle proofs)

Plus reduce BDK `syncParallelRequests` from 5 to 2 for incremental sync (keep higher for one-time full scan).

## Technical Considerations

### Architecture

All three capabilities live inside `src/ldk/sync/esplora-client.ts` as a private fetch wrapper, transparent to callers. No changes needed to `chain-sync.ts` or other consumers.

```
EsploraClient.getTxStatus(txid)
  -> private cachedFetch(url, cacheKey?)
    -> dedup check (return existing Promise if in-flight for same URL)
    -> semaphore acquire (wait if 2 already in-flight)
    -> fetch(url)
    -> semaphore release
    -> dedup map cleanup (.finally())
    -> cache store (if cacheKey provided)
```

### Implementation Detail

#### 1. Concurrency Limiter (`src/ldk/sync/esplora-client.ts`)

Simple semaphore pattern — a counter + queue of resolve callbacks:

```typescript
class Semaphore {
  private count: number
  private queue: (() => void)[] = []

  constructor(max: number) {
    this.count = max
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--
      return
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.count++
  }
}
```

- **Scope:** Per-HTTP-request (each `fetch()` call acquires/releases), not per-logical-operation. This gives the tightest control over concurrent connections to the server.
- **Max concurrency:** 2 (see brainstorm decision)
- The semaphore is a private member of `EsploraClient`, initialized in the constructor.

#### 2. In-Flight Request Deduplication (`src/ldk/sync/esplora-client.ts`)

A `Map<string, Promise<Response>>` keyed by URL. Before making a fetch, check if that URL is already in-flight. If so, return the same Promise. Cleanup via `.finally()` to match the proven pattern in `src/shared/fee-cache.ts:65-67`.

```typescript
private inflightRequests = new Map<string, Promise<Response>>()

private async dedupFetch(url: string, signal: AbortSignal): Promise<Response> {
  const existing = this.inflightRequests.get(url)
  if (existing) return existing

  const promise = this.semaphore.acquire().then(() =>
    fetch(url, { signal }).finally(() => this.semaphore.release())
  )
  this.inflightRequests.set(url, promise)
  promise.finally(() => this.inflightRequests.delete(url))
  return promise
}
```

- Covers all endpoints, including mutable ones (`getTxStatus`, `getOutspend`) — within a single sync tick, two concurrent calls to the same URL are wasteful regardless of mutability.
- The dedup map is naturally cleaned up on abort via `.finally()`.

#### 3. LRU Cache for Immutable Responses (`src/ldk/sync/esplora-client.ts`)

A simple `Map` with eviction (delete oldest on insert when at capacity). Three separate caches:

| Cache         | Key                             | Value                   | Max Entries |
| ------------- | ------------------------------- | ----------------------- | ----------- |
| Block headers | `blockHash` (64-char hex)       | `Uint8Array` (80 bytes) | 256         |
| Tx hex        | `txid` (64-char hex)            | `Uint8Array` (variable) | 256         |
| Merkle proofs | `txid:blockHash` (compound key) | `MerkleProof` object    | 256         |

**Critical: Merkle proofs use compound key `txid:blockHash`**, not just `txid`. During a reorg, a transaction can re-confirm in a different block at a different position. A txid-only key would serve a stale proof with the wrong `pos` value, causing LDK to construct an invalid merkle path. The compound key ensures a cache miss when the block hash changes post-reorg.

(Identified via SpecFlow analysis of `chain-sync.ts` reorg detection at lines 32-45)

**What is NOT cached:**

- `getTxStatus` — mutable (tx can go from unconfirmed to confirmed)
- `getOutspend` — mutable (output can go from unspent to spent)
- `getBlockStatus` — mutable (block can leave best chain during reorg)
- `getTipHash` — always changes
- Fee estimates — handled separately by `src/shared/fee-cache.ts`

**Cache is in-memory only.** IndexedDB persistence is out of scope for this iteration.

#### 4. Reduce BDK `syncParallelRequests` (`src/onchain/config.ts`)

Change both signet and mainnet `syncParallelRequests` from `5` to `2`.

**Exception for full scan:** `fullScanBdkWallet()` in `src/onchain/init.ts` runs once on wallet creation and scans across the gap limit (20 addresses). At 2 parallel, this could take significantly longer. Consider passing a higher value (e.g., 4) for `full_scan()` only, since it's a one-time operation that justifies more aggressive parallelism.

The `sync()` call in `src/onchain/sync.ts:54` uses the config value and should use 2.

### Performance Implications

**Request volume reduction by scenario:**

| Scenario                                              | Before                                          | After                                                               | Savings                        |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| Steady state, no new block                            | 1 req (tip check, early return)                 | 1 req                                                               | None needed                    |
| New block, 5 watched txids, 0 confirmed               | 1 + 1 + 1 + 5 = 8 reqs                          | Same 8 reqs, but max 2 concurrent                                   | Burst reduced from 5 to 2      |
| New block, 5 watched txids, 3 confirmed in same block | 8 + 3\*(header+hex+proof) = 17 reqs             | 8 + deduped: 1 header + 3 hex + 3 proof = 15 reqs, max 2 concurrent | 2 fewer reqs + burst throttled |
| New block, 10 outputs, 2 spent and confirmed          | 1+1+1+10+2\*(status+header+hex+proof) = 21 reqs | Same count, max 2 concurrent, header deduped if same block          | Burst reduced from ~12 to 2    |

The **concurrency limiter is the primary win** — it converts bursts into a steady trickle. Caching and dedup provide secondary savings when multiple items share a block.

### Security Considerations

- No new external inputs or user-facing surfaces
- Cache stores only data already fetched from esplora — no elevation of trust
- Semaphore has no persistence — restart clears all state

## System-Wide Impact

- **Interaction graph**: `EsploraClient` methods are called by `syncOnce()` in `chain-sync.ts`, and one-shot during `initLdk()` in `init.ts`. The middleware is internal to `EsploraClient` — callers are unaffected.
- **Error propagation**: Dedup means multiple callers share one Promise. If the fetch fails, all waiters get the same rejection. This is safe because `chain-sync.ts` uses `Promise.allSettled` (line 58, 89), which handles per-item rejections. The sequential calls at the top of `syncOnce` have a single caller per URL, so dedup doesn't affect error handling there.
- **State lifecycle risks**: The semaphore queue could accumulate waiters if the network is very slow. The existing 60s `SYNC_TIMEOUT_MS` (line 204 of `chain-sync.ts`) aborts all in-flight fetches via the abort signal, which also rejects queued semaphore waiters. No orphan risk.
- **BDK parity**: BDK uses a completely separate HTTP client (WASM). We can only control its parallelism via the `syncParallelRequests` config parameter. Every 3rd LDK tick overlaps with a BDK tick, potentially producing 2+2=4 concurrent requests. This is acceptable.

## Acceptance Criteria

- [x] `EsploraClient` has a private semaphore limiting concurrent fetches to 2
- [x] Identical in-flight URLs are coalesced into a single fetch, with `.finally()` cleanup
- [x] Block headers cached by `blockHash`, max 256 entries
- [x] Tx hex cached by `txid`, max 256 entries
- [x] Merkle proofs cached by `txid:blockHash` compound key, max 256 entries
- [x] Mutable endpoints (`getTxStatus`, `getOutspend`, `getBlockStatus`, `getTipHash`) are NOT cached but DO participate in dedup
- [x] BDK `syncParallelRequests` reduced to 2 for incremental sync in both signet and mainnet configs
- [x] BDK full scan retains higher parallelism (4) since it runs once on wallet creation
- [x] Existing tests in `esplora-client.test.ts` still pass
- [x] New tests cover: cache hit/miss, semaphore queuing, dedup coalescing, abort signal propagation through semaphore queue, compound merkle proof cache key
- [x] No regression in sync correctness (reorg detection, confirmation tracking)

## Success Metrics

- Elimination of HTTP 429 errors and CORS blocks from esplora servers during normal operation
- LDK sync completes within 60s timeout even with many watched items
- No increase in sync staleness (consecutive error count stays at 0 during normal operation)

## Dependencies & Risks

- **Risk:** BDK full scan at `syncParallelRequests: 2` may approach the 180s timeout. **Mitigation:** Use higher value (4) for `full_scan()` only.
- **Risk:** Head-of-line blocking with semaphore max 2 — a slow/timed-out request blocks the queue. **Mitigation:** Existing 10s per-request timeout (`FETCH_TIMEOUT_MS`) caps worst-case blocking. With 20 watched items and max 2 concurrent, worst case is ~100s, which is within the 60s sync timeout only if most complete fast. Monitor in practice.
- **Risk:** Rate limiting may persist despite optimization if the server's rate window is very aggressive. **Mitigation:** The existing exponential backoff (up to 5 min) handles this. A Cloudflare Worker proxy remains a future fallback (see brainstorm: rejected approaches).

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-04-07-esplora-request-batching-brainstorm.md](docs/brainstorms/2026-04-07-esplora-request-batching-brainstorm.md) — Key decisions: client-side only, max 2 concurrent, independent sync loops, cache immutable data.
- **Prior optimization:** [docs/plans/2026-04-06-001-fix-reduce-esplora-request-volume-plan.md](docs/plans/2026-04-06-001-fix-reduce-esplora-request-volume-plan.md) — Doubled LDK interval, tripled BDK interval, consolidated fee cache.

### Internal References

- LDK EsploraClient: `src/ldk/sync/esplora-client.ts`
- Chain sync loop: `src/ldk/sync/chain-sync.ts`
- Fee cache dedup pattern: `src/shared/fee-cache.ts:20,37-70`
- VSS chunked parallel pattern: `src/ldk/init.ts:285-314`
- BDK config: `src/onchain/config.ts:22,31`
- BDK sync: `src/onchain/sync.ts:54`
- BDK full scan: `src/onchain/init.ts:86-89`

### Institutional Learnings

- `docs/solutions/integration-issues/bdk-030-upgrade-nlocktime-and-chain-sync-consistency.md` — Never split related API calls; derive dependent values from single response
- `docs/solutions/design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md` — Exponential backoff with cap pattern
