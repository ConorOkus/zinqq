---
title: LDK Trait Defensive Hardening Patterns
problem_type: integration_issue
date: 2026-07-22
category: integration-issues
module: src/ldk/traits, src/ldk/storage
component: payments
symptoms:
  - 'Broadcaster fired HTTP POSTs with no retry — a failed justice or force-close broadcast meant stolen or stuck funds'
  - "Persist's onPersistFailure callback existed but was never wired to any handler, so channel-monitor persistence failures were silent"
  - 'Fee estimator accepted unbounded values from Esplora with no ceiling or type validation'
  - "ChannelManager persistence atomically cleared LDK's needs-persistence flag before the write completed, losing the retry signal on failure"
  - 'Peer address parser accepted non-hex pubkeys and path-traversal-style hosts that were interpolated directly into a WebSocket URL'
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags: [ldk, wasm, broadcaster, persistence, fee-estimator, retry, validation, vss]
related_components:
  [
    src/ldk/traits/broadcaster.ts,
    src/ldk/traits/fee-estimator.ts,
    src/ldk/traits/persist.ts,
    src/ldk/storage/persist-cm.ts,
    src/ldk/storage/serial-persister.ts,
    src/ldk/storage/vss-write.ts,
    src/ldk/peers/peer-connection.ts,
  ]
---

# LDK Trait Defensive Hardening Patterns

## Problem

LDK's trait implementations (`BroadcasterInterface`, `Persist`, `FeeEstimator`) bridge synchronous Rust/WASM callbacks to async browser I/O. LDK calls these traits expecting an immediate return — there is no `await` available inside `broadcast_transactions`, `persist_new_channel`, or `get_est_sat_per_1000_weight` — so every trait adapter has to fire-and-forget a promise and manage its own retry, validation, and failure propagation outside of what LDK itself schedules.

In March 2026 an audit of the trait adapters (the incident that originally motivated this doc) found several of them doing exactly that fire-and-forget with no safety net: a single HTTP POST with no retry backing a fund-safety-critical broadcast, a documented-but-unwired failure callback, unbounded numeric trust in an external fee API, an atomic-clear-then-maybe-lose-the-flag race in ChannelManager persistence, and a peer-address parser built on a blocklist instead of an allowlist. None of these fail loudly — WASM callbacks that swallow a rejected promise just look like nothing happened.

Since then the broadcaster and the persistence layer have been substantially rebuilt (this doc's Solution section describes the current architecture, not the March snapshot); the fee-estimator, peer-address-validation, and Web Locks patterns have held up largely unchanged and are re-verified below against current code.

## Symptoms

See frontmatter. In short: a fire-and-forget broadcast with no retry on a fund-critical path, a persistence failure hook that was defined but never consumed, an external fee input trusted without bounds, a dirty-flag race that could drop a pending ChannelManager write, and a peer-address host string trusted well past what's safe to interpolate into a WebSocket URL. All five are variants of the same failure shape: an async operation inside a synchronous trait callback failed silently because nothing was watching for the failure.

## What Didn't Work

**A single retry loop shared across all failure types.** The original broadcaster and the original ChannelManager persistence both used one flat "retry N times with backoff, then give up" shape. That's wrong for two reasons that only became apparent once real-world failure modes accumulated: (1) some HTTP error strings mean "this already succeeded, stop retrying" (a tx already confirmed, an RPC -27 for outputs already in the UTXO set) rather than "retry" — treating them as ordinary failures produced console noise indistinguishable from real broadcast failures; (2) ChannelManager persistence and ChannelMonitor persistence have different correctness requirements — the ChannelManager write can be scheduled by an external caller (chain-sync tick), but ChannelMonitor writes must halt channel operations until they succeed (LDK's `InProgress` return), so a shared retry policy either over-retries the wrong thing or halts wrongly.

**Deriving `archive_persisted_channel`'s storage key from `MonitorName.to_str()`.** LDK 0.2 passes `archive_persisted_channel` only a `MonitorName`, not a monitor handle. Reconstructing our `{txid}:{vout}` storage key by string-transforming `MonitorName`'s `{txid}_{vout}` form was considered and rejected — the byte order of the txid in `MonitorName`'s string form isn't guaranteed to match the storage key's, so a transform bug could silently target the wrong key. `persist.ts` instead maintains an explicit `nameToKey` map populated at every `persist_new_channel`/`update_persisted_channel` call and at startup via `registerLoadedMonitor`, and logs-and-returns on a miss rather than guessing.

**Trusting broadcaster sentinel strings unconditionally everywhere.** Mapping esplora error text like "inputs missing or spent" to an "already broadcast, stop retrying" sentinel is safe when the broadcasting code's inputs are exclusively LDK's own (force-close, justice, HTLC-claim transactions — nothing else in the wallet can spend them). It stopped being safe the moment a second code path began building transactions that mix LDK-derived outputs with ordinary BDK wallet UTXOs (the fee-subsidized sweep, see Related). That consumer now independently verifies against esplora before deleting any state on a sentinel return — the broadcaster's sentinel semantics were not relaxed for it (see `ldk-spendable-output-sweep-stuck-retry-and-fee-semantics.md`).

## Solution

### 1. Broadcaster: Primary/Fallback Retry, Timeout, De-dupe, and Persisted Pending Broadcasts

`src/ldk/traits/broadcaster.ts` is the current shape:

```typescript
const MAX_BROADCAST_RETRIES = 5
const FALLBACK_RETRIES = 3
const RETRY_DELAY_MS = 1_000
const PENDING_BROADCAST_TTL_MS = 48 * 60 * 60 * 1_000 // 48 hours
const FETCH_TIMEOUT_MS = 10_000

const inflightTxs = new Set<string>()

export async function broadcastWithRetry(
  esploraUrl: string,
  txHex: string,
  fallbackUrl?: string
): Promise<string> {
  if (inflightTxs.has(txHex)) return 'in-flight' // de-dupe concurrent broadcasts of the same tx
  inflightTxs.add(txHex)
  try {
    const primaryResult = await tryBroadcast(esploraUrl, txHex, MAX_BROADCAST_RETRIES, 'primary')
    if (primaryResult) return primaryResult
    if (fallbackUrl) {
      const fallbackResult = await tryBroadcast(fallbackUrl, txHex, FALLBACK_RETRIES, 'fallback')
      if (fallbackResult) return fallbackResult
    }
    throw new Error(`All broadcast attempts failed for tx ${txHex.slice(0, 16)}...`)
  } finally {
    inflightTxs.delete(txHex)
  }
}
```

Each POST carries `signal: AbortSignal.timeout(10_000)` — a hung request would otherwise pin `inflightTxs` (and any module-level in-progress guard built on top of it, e.g. the sweep retry loop) forever. Each attempt runs against the primary esplora with 5 retries at exponential backoff, then — if the primary is exhausted — against a `fallbackUrl` with 3 more retries.

Not every non-2xx response is a retryable failure. `postTxToEsplora` checks the response body against seven lowercase substring patterns before deciding to retry:

```typescript
lower.includes('transaction already in block chain') ||
  lower.includes('txn-already-known') ||
  lower.includes('txn-already-confirmed') ||
  lower.includes('insufficient fee, rejecting replacement') ||
  lower.includes('outputs already in utxo set') ||
  lower.includes('-27') ||
  lower.includes('bad-txns-inputs-missingorspent') ||
  lower.includes('-25')
```

The RPC -27 and -25 entries exist for a specific reason documented in-code: after a successful CPFP-bumped force close, LDK keeps re-issuing the now-confirmed commitment and anchor child for a while, and both error codes are what a node returns when it recognizes the outputs/inputs are already settled on chain. Without them, every one of those re-issues would log as a critical broadcast failure even though nothing is actually wrong.

**Persisted pending broadcasts.** `broadcast_transactions` writes each tx to the `ldk_pending_broadcasts` IDB store (keyed by hex, with a `createdAt` timestamp) in parallel with kicking off `broadcastWithRetry`, and only deletes the IDB entry once _both_ the put and the broadcast have resolved — chaining delete after `Promise.all`-style sequencing rather than firing it independently avoids a race where delete could run before the put commits, orphaning the entry. `drainPendingBroadcasts(esploraUrl, fallbackUrl)` runs once at startup after LDK init, reads every entry, discards anything older than the 48-hour TTL (inputs are almost certainly spent or superseded by then), and re-drives `broadcastWithRetry` for the rest — this is the crash-recovery path for a browser that closed mid-broadcast.

**Key insight:** the broadcaster's retry and the chain-sync tick's `chainMonitor.rebroadcast_pending_claims()` are two independent safety nets for the same fund-critical class of transaction (force-close, justice, HTLC-claim). The broadcaster hardens a single invocation; LDK's own rebroadcast loop is the outer net if the browser dies mid-retry. Neither replaces the other.

**Consumer caveat (added 2026-07):** the sentinel-string mapping above is correct only because, historically, every transaction passed through `broadcast_transactions` spent inputs LDK itself controls — nothing else in the wallet can create a conflicting spend. That assumption broke when the fee-subsidized spendable-output sweep started building transactions that also spend ordinary BDK wallet UTXOs as a fee subsidy. For that specific call site, an "inputs missing or spent" response is ambiguous — it could mean "already broadcast" (safe to trust) or "a concurrent, unrelated wallet spend beat us to this input" (not safe to trust, because deleting the swept descriptors would lose the funds). The sweep code independently re-verifies against esplora's `/tx/{txid}` before believing a non-matching-txid broadcast result; the broadcaster itself was not changed, since its LDK-only-input callers still get the sentinel free ride. See `ldk-spendable-output-sweep-stuck-retry-and-fee-semantics.md` for the full mechanism.

### 2. Persistence: Two Independent Hardened Paths, Not One Retry Flag

The old architecture had a single boolean (`cmNeedsPersist`) covering ChannelManager persistence in the sync-loop tick. That's gone. Persistence is now two structurally different subsystems, because ChannelManager and ChannelMonitor persistence have different correctness contracts.

**ChannelManager — single-flight scheduler over a VSS-then-IDB dual write.** `src/ldk/storage/persist-cm.ts` exposes `persistChannelManager(cm, ctx)`, which writes to VSS first (if configured, via `vssWriteWithConflictRetry`) and then to IDB — and does **not** retry indefinitely itself; the caller owns retry scheduling. That caller is `createChannelManagerPersistScheduler(cm, ctx)`, which wraps `persistChannelManager` in `createSerialPersister` (`src/ldk/storage/serial-persister.ts`) — a generic single-flight + trailing-coalesce + must-retry primitive:

```typescript
export function createChannelManagerPersistScheduler(
  cm: ChannelManager,
  ctx: CmPersistContext = {}
): ChannelManagerPersistScheduler {
  return createSerialPersister(
    () => persistChannelManager(cm, ctx),
    () => cm.get_and_clear_needs_persistence()
  )
}
```

The scheduler, not the sync loop, owns LDK's dirty bit. Callers invoke `schedule()` unconditionally on every tick; internally it consults `hasPendingWork` (here, `cm.get_and_clear_needs_persistence()`) to decide whether there's anything to do, coalesces concurrent `schedule()` calls into one in-flight run plus at most one trailing run, and — critically — latches a `mustRetry` flag if a run throws, so the _next_ `schedule()` call retries even if LDK's own dirty bit doesn't fire again in the interim. This is the direct architectural answer to the old `cmNeedsPersist`-boolean race: instead of one flag next to the atomic clear, the scheduler treats "did the last write fail" as sticky state independent of whatever LDK's dirty bit says next.

`src/ldk/sync/chain-sync.ts`'s tick calls `await config.schedulePersist()` after `channelManager.timer_tick_occurred()` and `chainMonitor.rebroadcast_pending_claims()`, and _before_ the (best-effort) `onSynced` feature hook — comments in the code are explicit that fund-critical persistence must never be delayed behind a slower, non-critical Esplora-backed hook. A throw from `schedulePersist()` propagates into the tick's own error handling, which is correct: the scheduler's internal `mustRetry` will pick the work back up on the next tick regardless.

The VSS write itself (`vssWriteWithConflictRetry` in `src/ldk/storage/vss-write.ts`) retries once on a genuine version conflict (409), but first checks a "takeover-grace" window: if the conflict lands within 1 second of this tab acquiring the multi-tab Web Lock (see section 5), it's likely the _previous_ tab's late write landing after our version read — overwriting it would clobber state that tab persisted moments before shutdown, so it throws `VssConflictDuringTakeoverError` instead of retrying, and the scheduler's must-retry path picks it up next round. This dual-write/version-conflict story is shared by ChannelManager, known-peers, and recovery-state persistence and is documented in full in `vss-dual-write-persistence-with-version-conflict-resolution.md` and `vss-remote-state-recovery-full-integration.md` — not duplicated here.

**ChannelMonitor — per-channel serialized writes with indefinite backoff.** `src/ldk/traits/persist.ts` is structurally different because a ChannelMonitor persistence failure must halt channel operations (LDK's `ChannelMonitorUpdateStatus.InProgress` return, cleared only by calling `chainMonitor.channel_monitor_updated` after a successful write) rather than being retried on a fixed schedule by an outer caller:

- Every `persist_new_channel`/`update_persisted_channel` call extracts the monitor's owned bytes (`monitor.write()`), channel ID, funding outpoint, and update ID **synchronously**, inside the callback — the `monitor` handle is borrowed and freed by Rust the moment the callback returns, so nothing derived from it may be touched inside an async continuation.
- `channelWriteChains`, a `Map<key, Promise<void>>`, serializes writes per channel so concurrent updates to the same monitor can't race on the VSS version cache; LDK's own `InProgress` halt keeps this queue's depth bounded at 1-2.
- `persistWithRetry` writes VSS first, then IDB, with **indefinite** exponential backoff (500ms → 60s cap) rather than a bounded retry count — channel operations are already halted, so there is no "give up" state; giving up would mean silently losing the ability to enforce a channel's on-chain state. After 10 seconds of continuous backoff it fires `onVssUnavailable` (surfaced as a degraded-state signal to the UI) and `onVssRecovered` on the next success.
- VSS version conflicts get up to `MAX_CONFLICT_RETRIES = 5` immediate re-fetch-and-retry attempts (merging server data when it's identical, logging critical and overwriting-with-corrected-version when it genuinely differs) before falling through to the same backoff loop — and once conflict retries are exhausted, subsequent conflicts on that key skip straight to backoff rather than re-entering the conflict-retry counter, which prevents a degenerate infinite-conflict loop.
- A `_monitor_keys` manifest (JSON array of `{txid}:{vout}` keys, capped at 1,000 entries, parsed defensively via `parseMonitorManifest`) is written to VSS on every add/remove, using the same server-merge-on-conflict logic, so a fresh device/tab can discover which monitors to restore without enumerating every possible key.
- `archive_persisted_channel(monitor_name)` resolves the storage key via an explicit `nameToKey` map (populated by every persist/update call and by `registerLoadedMonitor` for monitors restored at startup) rather than deriving it from `MonitorName.to_str()` — see "What Didn't Work" above for why. A miss logs a warning and returns rather than guessing; the failure mode (orphaned VSS/IDB storage) is fund-safe because the channel is already closed.

**Key insight, unchanged from the original doc but now with the correct mechanism:** any LDK API that atomically clears a flag (`get_and_clear_needs_persistence`, `get_and_clear_completed_updates`) needs the _caller_ to own a durable "did the last attempt succeed" signal, because the clear happens whether or not the subsequent write succeeds. The current fix is a generic single-flight scheduler with a must-retry latch (`serial-persister.ts`), not a single ad hoc boolean living next to the clear call.

### 3. Fee Estimator: Type Validation + Ceiling Cap (unchanged, verified current)

`src/ldk/traits/fee-estimator.ts` still caps every computed rate at `MAX_FEE_SAT_KW = 500_000` (~2,000 sat/vB) and layers per-`ConfirmationTarget` floors on top of whatever `getCachedFeeRate` returns:

```typescript
const MAX_FEE_SAT_KW = 500_000 // ~2,000 sat/vB — beyond this, something is wrong

export function computeFeeRateSatKw(confirmationTarget: ConfirmationTarget): number {
  const targetBlocks = targetToBlocks(confirmationTarget)
  const satPerVb = getCachedFeeRate(targetBlocks)
  const satKw = Math.min(Math.round(satPerVb * 250), MAX_FEE_SAT_KW)
  return Math.max(satKw, DEFAULT_FEE_RATES[confirmationTarget] ?? 253, 253)
}
```

Two details worth calling out that weren't in the original write-up: `UrgentOnChainSweep` (anchor-CPFP, justice, HTLC-claim fee bumps) deliberately reads esplora's 3-block estimate rather than the 1-block estimate — the 1-block number is a "what recent high-priority transactions paid" figure that can read 75+ sat/vB in a quiet mempool that's actually confirming at 1 sat/vB, while anchor channels give the wallet the full `to_self_delay` (typically 144+ blocks) of headroom, so trading ~30 minutes of latency for not overpaying 30x is the safer default. And `MinAllowedNonAnchorChannelRemoteFee`/`MinAllowedAnchorChannelRemoteFee` are floored at LDK's absolute minimum (253 sat/kW, i.e. 1 sat/vB) specifically so a trusted LSP proposing a low commitment fee isn't rejected at channel open — a comment in the code flags this as inherited from the (now-removed) LQwD integration and worth re-verifying against Megalith before tightening.

### 4. Peer Address: Allowlist over Blocklist (unchanged, verified current)

Both `src/ldk/peers/peer-connection.ts`'s `connectToPeer` (inline validation before opening the WebSocket) and its exported `parsePeerAddress` helper (for parsing a full `pubkey@host:port` string) apply the same two checks:

```typescript
if (!/^[0-9a-f]{66}$/.test(pubkey))
  throw new Error('Invalid pubkey: must be 66 lowercase hex characters')
if (!/^[a-zA-Z0-9._-]+$/.test(host))
  throw new Error('Invalid host: must contain only alphanumeric, dot, hyphen, or underscore')
```

**Key insight, still true:** the host is interpolated directly into a WebSocket proxy URL (`${LDK_CONFIG.wsProxyUrl}/v1/${proxyHost}/${port}`, with dots swapped for underscores). A blocklist on `/[/?#]/` misses `@`, backslash, whitespace, and percent-encoded sequences; a DNS-safe allowlist closes all of those at once. The port is separately bounds-checked (`1`-`65535`) in both call sites.

### 5. Web Locks: Hard Failure, Not Silent Continuation (verified current — behavior improved since March)

The March incident found that the Web Locks multi-tab guard silently continued without protection when `navigator.locks` was unavailable. That is no longer the current behavior: `src/ldk/init.ts`'s `acquireWalletLock` now throws instead:

```typescript
async function acquireWalletLock(): Promise<void> {
  if (!navigator.locks) {
    throw new Error(
      '[LDK Init] Web Locks API not available. ' +
        'A modern browser with Web Locks support is required to prevent multi-tab fund loss.'
    )
  }
  const bc = new BroadcastChannel(WALLET_LOCK_CHANNEL)
  bc.postMessage({ type: 'wallet-takeover' })
  bc.close()

  return new Promise<void>((resolve) => {
    void navigator.locks.request('zinqq-lock', { steal: true }, () => {
      walletLockAcquiredAt = Date.now()
      resolve()
      return new Promise<void>(() => {}) // hold the lock forever
    })
  })
}
```

`{ steal: true }` means the most recently opened tab always wins the lock — deliberately, to avoid a stale lock from a crashed tab, bfcache, or a stuck service worker blocking every future restore. Before stealing, the new tab broadcasts a `wallet-takeover` message on `BroadcastChannel('zinqq-wallet-lock')` so the outgoing tab can tear its LDK node down cleanly rather than fighting the new tab for storage writes. `walletLockAcquiredAt` — the timestamp this tab won the lock — is exported and consumed by `vss-write.ts`'s takeover-grace check (section 2 above): a VSS conflict landing within one second of a takeover is treated as "the old tab's last write, not a real conflict" rather than triggering an overwrite.

### 6. Smaller, still-current patterns

Two narrower patterns from the original audit remain unchanged in current code and are worth keeping in the catalog:

- **Seed loading copies cross-realm typed-array bytes** (`src/ldk/storage/seed.ts`). IndexedDB's structured clone can return a `Uint8Array` from a different realm that fails `instanceof` but passes `ArrayBuffer.isView`; `getSeed()` handles that case by copying the bytes into a fresh `Uint8Array` rather than sharing the underlying `ArrayBuffer`, which would risk silent corruption if that buffer were later detached. Anything else is treated as corruption and throws.
- **NetworkGraph/Scorer counter increments after the write, not before** (`src/ldk/sync/chain-sync.ts`). The tick still writes `ldk_network_graph`/`ldk_scorer` to IDB every 10th successful tick and only increments `tickCount` afterward, so a write failure retries on the next tick instead of the counter silently advancing past a lost write.

## Why This Works

The unifying constraint across every trait adapter is the same one that motivated the original audit: LDK's synchronous callback contract means the adapter, not LDK, is the only thing that can notice an async failure. Every pattern above is a variation on "make the failure durable and visible instead of letting the promise chain swallow it": the broadcaster persists pending transactions to IDB before racing the network so a crash mid-broadcast isn't a lost transaction; the ChannelManager scheduler latches a must-retry flag instead of relying on LDK's dirty bit to fire again; ChannelMonitor persistence halts channel operations rather than pretending a failed write succeeded; the fee estimator and peer-address validators refuse to let external, attacker-influenceable input reach LDK or a WebSocket URL unconstrained; and the Web Locks guard now fails the whole init rather than quietly running two ChannelManagers against the same funds.

The broadcaster/sweep interaction is the sharpest illustration of why these patterns can't be lifted verbatim between call sites: a sentinel string that safely means "already broadcast, stop worrying" for one caller's input set can mean "someone else already spent this" for a different caller whose inputs are shared with the rest of the wallet. Hardening has to be re-derived from what each adapter's inputs actually are, not copy-pasted from the last adapter that needed hardening.

## Prevention

1. **Every fire-and-forget async operation in a trait callback must have retry logic, and that logic must distinguish "retry" from "already succeeded, stop."** A flat retry-on-any-failure loop produces false alarms for the sentinel cases (already broadcast, already confirmed) that a specific error-string check would filter out.
2. **Any API that atomically clears a flag (`get_and_clear_*`) needs the caller to own a durable, sticky "did the last write succeed" signal** — not just a boolean that lives next to the clear call, but a scheduler that survives across ticks and re-attempts even if the upstream dirty bit doesn't fire again.
3. **Choose bounded vs. indefinite retry based on what happens while you wait.** ChannelManager persistence can be retried on the next scheduled tick because nothing is blocked in the meantime; ChannelMonitor persistence retries indefinitely because LDK halts channel operations until it succeeds — there is no safe "give up" state.
4. **Use allowlists, not blocklists, for input validation** — especially when the input is interpolated into a URL. This applies identically wherever a hostname reaches a WebSocket or fetch call.
5. **Cap external numeric inputs at the boundary** (fee rates, amounts, heights). A compromised or misbehaving fee API should not be able to drain the wallet via fee overpayment.
6. **Re-verify a sentinel/allowlist assumption every time a new consumer starts sharing state with an existing hardened path.** The broadcaster's sentinel semantics were correct for years because every caller's inputs were LDK-exclusive; they became unsafe the moment a caller's inputs started overlapping with the rest of the wallet's UTXO set, and the fix belonged in the new caller, not a broadcaster-wide relaxation.
7. **Always copy cross-realm typed-array bytes; never share the underlying `ArrayBuffer`.** `instanceof Uint8Array` can fail across IndexedDB's structured-clone boundary even when `ArrayBuffer.isView` succeeds.
8. **Place counter increments after the operations they gate**, not before, so a failed operation doesn't get silently counted as done.

## Related Issues

- `docs/solutions/design-patterns/vss-dual-write-persistence-with-version-conflict-resolution.md` — the full VSS-then-IDB dual-write and version-conflict-retry mechanism shared by ChannelManager, ChannelMonitor manifest, known-peers, and recovery-state persistence.
- `docs/solutions/integration-issues/vss-remote-state-recovery-full-integration.md` — Phase 1 VSS integration this persistence layer builds on.
- `docs/solutions/integration-issues/ldk-spendable-output-sweep-stuck-retry-and-fee-semantics.md` — the fee-subsidized sweep whose shared LDK+BDK inputs are why broadcaster sentinel returns can no longer be trusted unconditionally at every call site.
- `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` — sync/async trait bridging patterns this doc's adapters build on.
- `docs/solutions/integration-issues/bdk-wasm-onchain-send-patterns.md` — similar defensive patterns for the BDK send flow.
- `docs/solutions/integration-issues/ldk-event-handler-patterns.md` — the event-drain/timer-loop pattern that chain-sync's persistence scheduling and the broadcaster's pending-broadcast drain both extend.
- PR #11: https://github.com/ConorOkus/browser-wallet/pull/11 — original March 2026 hardening pass.
