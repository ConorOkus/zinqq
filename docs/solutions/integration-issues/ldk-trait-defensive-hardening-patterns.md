---
title: LDK Trait Defensive Hardening Patterns
category: integration-issues
date: 2026-03-14
tags: [ldk, wasm, fund-safety, retry, validation, indexeddb, persistence, broadcaster, fee-estimator]
modules: [src/ldk/traits, src/ldk/init, src/ldk/sync, src/ldk/peers, src/ldk/storage]
severity: HIGH
---

# LDK Trait Defensive Hardening Patterns

## Problem

LDK's trait implementations (`BroadcasterInterface`, `Persist`, `FeeEstimator`) bridge synchronous Rust/WASM callbacks to async browser I/O. Several trait adapters had silent failure modes that could lead to fund loss:

1. **Broadcaster** fired HTTP POSTs with no retry — justice transaction failure = stolen funds
2. **Persist** returned `onPersistFailure` callback but it was never consumed
3. **Fee estimator** accepted unbounded values from Esplora with no ceiling or type validation
4. **Chain-sync** used `key.split(':')` with no validation, passed NaN to Esplora API
5. **ChannelManager persistence** atomically cleared LDK's dirty flag, then if `idbPut` failed the flag was lost
6. **Web Locks** silently continued without multi-tab protection when API unavailable
7. **Peer address parser** accepted non-hex pubkeys and path-traversal hosts

## Root Cause

The fundamental tension: LDK trait callbacks are **synchronous** (must return immediately), but all browser I/O is **async**. Every trait adapter bridges this gap with fire-and-forget promises. The original implementations logged errors to `console.error` but had no retry, validation, or failure propagation — acceptable for a prototype but dangerous for a wallet managing real funds.

## Solution

### 1. Broadcaster: Retry with Exponential Backoff

```typescript
// src/ldk/traits/broadcaster.ts
const MAX_BROADCAST_RETRIES = 5
const RETRY_DELAY_MS = 1_000

async function broadcastWithRetry(esploraUrl: string, txHex: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
    try {
      const res = await fetch(`${esploraUrl}/tx`, { method: 'POST', body: txHex })
      if (res.ok) { /* success */ return }
      const body = await res.text()
      // Don't retry if tx is already known to the network
      if (body.includes('Transaction already in block chain') ||
          body.includes('txn-already-known')) return
      throw new Error(`HTTP ${res.status}: ${body}`)
    } catch (err) {
      if (attempt < MAX_BROADCAST_RETRIES)
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * 2 ** (attempt - 1)))
    }
  }
}

// broadcast_transactions is synchronous — fire-and-forget the async retry
broadcast_transactions(txs: Uint8Array[]): void {
  for (const tx of txs) void broadcastWithRetry(esploraUrl, bytesToHex(tx))
}
```

**Key insight:** LDK's `rebroadcast_pending_claims()` runs every 30-second sync tick, providing an outer retry loop. The broadcaster retry is defense-in-depth for a single invocation, not the last line of defense.

### 2. CM Persistence: Retry Flag for Atomic Clear

```typescript
// src/ldk/sync/chain-sync.ts
let cmNeedsPersist = false

// In tick():
if (cmNeedsPersist || channelManager.get_and_clear_needs_persistence()) {
  cmNeedsPersist = false
  try {
    await idbPut('ldk_channel_manager', 'primary', channelManager.write())
  } catch (err) {
    cmNeedsPersist = true  // Retry next tick
    throw err
  }
}
```

**Key insight:** `get_and_clear_needs_persistence()` atomically clears LDK's internal flag. If the subsequent `idbPut` fails, the flag is gone. A local `cmNeedsPersist` boolean ensures the next tick retries. The re-thrown error skips NetworkGraph/Scorer persistence (correct — those are lower priority).

### 3. Fee Estimator: Type Validation + Ceiling Cap

```typescript
const MAX_FEE_SAT_KW = 500_000 // ~2,000 sat/vB

for (const [blocks, feePerVbyte] of Object.entries(estimates)) {
  if (typeof feePerVbyte !== 'number' || !Number.isFinite(feePerVbyte) || feePerVbyte <= 0)
    continue  // Skip invalid entries
  const satKw = Math.round(feePerVbyte * 250)
  rates.set(Number(blocks), Math.min(satKw, MAX_FEE_SAT_KW))
}
```

### 4. Seed Type Validation with Cross-Realm Fallback

```typescript
export async function getSeed(): Promise<Uint8Array | undefined> {
  const raw = await idbGet<Uint8Array>('ldk_seed', SEED_KEY)
  if (raw === undefined) return undefined
  if (raw instanceof Uint8Array) return raw
  // IndexedDB structured clone can produce typed arrays from different realms
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    //                     ^^^^^^^^^^^^^^^^ copy bytes — don't share the ArrayBuffer
  }
  throw new Error('[Seed] Stored seed is not a Uint8Array — possible data corruption')
}
```

**Key insight:** Always **copy** bytes from cross-realm typed arrays. Sharing the `ArrayBuffer` via `new Uint8Array(raw.buffer)` risks silent corruption if the buffer is later detached.

### 5. Peer Address: Allowlist over Blocklist

```typescript
if (!/^[0-9a-f]{66}$/.test(pubkey))
  throw new Error('Invalid peer address: pubkey must be 66 lowercase hex characters')
if (!/^[a-zA-Z0-9._-]+$/.test(host))
  throw new Error('Invalid peer address: host must contain only alphanumeric, dot, hyphen, or underscore')
```

**Key insight:** The host gets interpolated into a WebSocket URL. A blocklist (`/[/?#]/`) misses `@`, `\`, spaces, percent-encoded sequences. A DNS-safe allowlist is strictly better.

### 6. NetworkGraph/Scorer: Increment After Persistence

```typescript
// Move tickCount++ AFTER the writes so failure retries next tick
if ((tickCount + 1) % 10 === 0) {
  await idbPut('ldk_network_graph', 'primary', networkGraph.write())
  await idbPut('ldk_scorer', 'primary', scorer.write())
}
tickCount++
```

## Prevention

1. **Every fire-and-forget async operation in a trait callback must have retry logic.** LDK cannot retry for you — its callbacks are synchronous.
2. **Any API that atomically clears a flag (`get_and_clear_*`) needs a local retry flag** if the subsequent operation can fail.
3. **Use allowlists, not blocklists, for input validation** — especially when the input is interpolated into URLs.
4. **Cap external numeric inputs** at the boundary (fee rates, amounts, heights). A compromised API should not be able to drain the wallet via fee overpayment.
5. **Always copy cross-realm typed array bytes.** `instanceof Uint8Array` can fail across iframes/workers/structured clone boundaries.
6. **Place counter increments after the operations they gate**, not before. If the operation fails, the counter should not advance.

## Related

- `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` — sync/async trait bridging patterns
- `docs/solutions/integration-issues/bdk-wasm-onchain-send-patterns.md` — similar defensive patterns for BDK send flow
- PR #11: https://github.com/ConorOkus/browser-wallet/pull/11
