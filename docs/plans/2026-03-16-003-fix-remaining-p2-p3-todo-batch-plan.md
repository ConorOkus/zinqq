---
title: "fix: Remaining P2 + P3 todo batch — sync hardening, security UX, and cleanup"
type: fix
status: active
date: 2026-03-16
---

# fix: Remaining P2 + P3 todo batch — sync hardening, security UX, and cleanup

## Overview

All P1 critical bugs are resolved. This plan addresses the **11 remaining P2** and **17 remaining P3** todos, organized into 6 implementation phases by dependency chain. The sync loop changes (021/025/027/030) are the most interconnected and must be designed as a unit. Security UX fixes (046/091) and refactoring (005/006/028/049) are independent.

**Deferred items (out of scope):**
- 045 — Plaintext mnemonic in IDB (deferred to mainnet; requires SubtleCrypto encryption layer)
- 094 — Auth gate before seed reveal (deferred to mainnet; requires PIN/biometric architecture)
- 016 — NodeManager singleton (architectural; deferred until headless/agent use case is concrete)
- 072 — Extract onchain service for agent parity (deferred with 016)

## Phase 1: Esplora Client Hardening (020, 030)

**Prerequisite for all sync loop changes. Do this first.**

### 1.1 Add fetch timeout to all Esplora calls (todo 030)

**File:** `src/ldk/sync/esplora-client.ts`

Add `AbortSignal.timeout(10_000)` to every `fetch()` call in the Esplora client. This prevents hung connections from blocking the sync loop indefinitely.

```typescript
// Apply to every fetch call in esplora-client.ts:
const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
```

### 1.2 Add response validation to Esplora client (todo 020)

**File:** `src/ldk/sync/esplora-client.ts`, `src/ldk/utils.ts`

**Problems:**
- `getTipHeight`: `parseInt(text, 10)` returns NaN on garbage response
- `getTipHash`/`getBlockHeader`: no hex format validation, `hexToBytes` silently converts invalid chars to `0x00`
- JSON endpoints (`getBlockStatus`, `getTxStatus`, etc.): `as T` casts with no runtime check

**Fix:**

```typescript
// esplora-client.ts — add a hex regex guard
function assertHex(value: string, label: string): void {
  if (!/^[0-9a-f]+$/.test(value)) {
    throw new Error(`[Esplora] Invalid hex in ${label}: ${value.slice(0, 20)}...`)
  }
}

// getTipHeight — validate integer
async getTipHeight(): Promise<number> {
  const res = await fetch(`${this.baseUrl}/blocks/tip/height`, { signal: AbortSignal.timeout(10_000) })
  const text = await res.text()
  const height = parseInt(text, 10)
  if (!Number.isFinite(height) || height < 0) {
    throw new Error(`[Esplora] Invalid tip height: ${text}`)
  }
  return height
}

// getTipHash — validate 64-char hex
async getTipHash(): Promise<string> {
  const res = await fetch(`${this.baseUrl}/blocks/tip/hash`, { signal: AbortSignal.timeout(10_000) })
  const hash = await res.text()
  assertHex(hash.trim(), 'tipHash')
  return hash.trim()
}

// JSON endpoints — add minimal shape checks
async getBlockStatus(hash: string): Promise<BlockStatus> {
  assertHex(hash, 'blockHash')
  const res = await fetch(`${this.baseUrl}/block/${hash}/status`, { signal: AbortSignal.timeout(10_000) })
  const data: unknown = await res.json()
  if (typeof data !== 'object' || data === null || !('in_best_chain' in data)) {
    throw new Error(`[Esplora] Malformed block status response`)
  }
  return data as BlockStatus
}
```

Apply the same pattern to `getTxStatus`, `getTxMerkleProof`, `getOutspend`.

**Also fix `hexToBytes` in `src/ldk/utils.ts`:**

```typescript
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Hex string must have even length')
  if (!/^[0-9a-f]*$/i.test(hex)) throw new Error('Invalid hex characters')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}
```

## Phase 2: Sync Loop Improvements (021, 025, 027, 023)

**These 4 items interact and must be implemented together.**

### 2.1 Parallelize HTTP calls in syncOnce (todo 025)

**File:** `src/ldk/sync/chain-sync.ts`

Replace the sequential `for...of` loops for watched txids and watched outputs with `Promise.allSettled`. Use `allSettled` (not `Promise.all`) so individual 502/timeout failures don't abort the entire tick.

```typescript
// Replace sequential watched-txid loop with:
const txResults = await Promise.allSettled(
  [...watchState.watchedTxids.entries()].map(async ([txid, script]) => {
    const status = await esplora.getTxStatus(txid)
    if (status.confirmed && status.block_hash) {
      // ... confirmation logic
      return { txid, confirmed: true }
    }
    return { txid, confirmed: false }
  })
)
const failedTxChecks = txResults.filter(r => r.status === 'rejected')
if (failedTxChecks.length > 0) {
  console.warn(`[LDK Sync] ${failedTxChecks.length} txid checks failed`)
}

// Same pattern for watched-output loop
```

### 2.2 Add error backoff and sync status (todo 021)

**File:** `src/ldk/sync/chain-sync.ts`, `src/ldk/context.tsx`

**Backoff strategy:** Capped exponential — base = `intervalMs` (30s), factor = 2, cap = 5 minutes, reset on first successful sync.

**Sync status state machine:**
- `syncing` → `synced`: after first successful `syncOnce` call
- `synced` → `syncing`: when tip hash changes (new block)
- `synced`/`syncing` → `stale`: after 3 consecutive failed sync ticks
- `stale` → `syncing`: on next attempted tick

```typescript
// chain-sync.ts — add to SyncLoopConfig:
onStatusChange?: (status: 'syncing' | 'synced' | 'stale') => void

// In startSyncLoop:
let consecutiveErrors = 0
let currentBackoff = intervalMs

// After successful syncOnce:
consecutiveErrors = 0
currentBackoff = intervalMs
config.onStatusChange?.('synced')

// After failed syncOnce:
consecutiveErrors++
currentBackoff = Math.min(currentBackoff * 2, 5 * 60 * 1000) // cap at 5 min
if (consecutiveErrors >= 3) config.onStatusChange?.('stale')

// Schedule next tick:
timeout = setTimeout(tick, currentBackoff)
```

Wire `onStatusChange` in `context.tsx` to update `syncStatus` in the LDK context state.

### 2.3 Prune confirmed items from WatchState maps (todo 027)

**File:** `src/ldk/traits/filter.ts`, `src/ldk/sync/chain-sync.ts`

After `transactions_confirmed` is called, compare `watchedTxids` against the set returned by `get_relevant_txids()`. Remove entries no longer in the relevant set (LDK has fully processed them).

```typescript
// At end of syncOnce, after all confirmations processed:
const relevantTxids = new Set(
  channelManager.get_relevant_txids().map(([txid]) => bytesToHex(txid))
)
for (const txid of watchState.watchedTxids.keys()) {
  if (!relevantTxids.has(txid)) {
    watchState.watchedTxids.delete(txid)
  }
}
// Similar for watchedOutputs — prune spent outputs that are no longer relevant
```

### 2.4 Persist on tab close (todo 023)

**File:** `src/ldk/context.tsx`

Use `visibilitychange` (more reliable than `beforeunload` for async IDB writes). Accept that writes may not complete — rely on periodic persistence (every tick) to limit the data loss window.

```typescript
// In useEffect alongside the sync loop setup:
const handleVisibilityChange = () => {
  if (document.visibilityState === 'hidden' && nodeRef.current) {
    const { channelManager, networkGraph, scorer } = nodeRef.current
    // Fire-and-forget — best-effort flush
    void Promise.all([
      idbPut('ldk_channel_manager', 'primary', channelManager.write()),
      idbPut('ldk_network_graph', 'primary', networkGraph.write()),
      idbPut('ldk_scorer', 'primary', scorer.write()),
    ]).catch(err => console.error('[LDK] Visibility-change persist failed:', err))
  }
}
document.addEventListener('visibilitychange', handleVisibilityChange)

// Cleanup:
return () => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  // ... existing cleanup
}
```

## Phase 3: WebSocket Cleanup (036)

**File:** `src/ldk/peers/peer-connection.ts`, `src/ldk/context.tsx`

### 3.1 Return disconnect handle from connectToPeer

Change `connectToPeer` to return a disconnect function so the context can track and clean up connections.

```typescript
// peer-connection.ts — change return type:
export async function connectToPeer(
  peerManager: PeerManager,
  pubkey: string,
  host: string,
  port: number,
  wsProxyUrl: string,
): Promise<{ disconnect: () => void }> {
  // ... existing WebSocket setup ...
  return {
    disconnect: () => {
      if (descriptor) {
        peerManager.socket_disconnected(descriptor)
      }
      ws.close()
    },
  }
}
```

### 3.2 Track active connections in context

```typescript
// context.tsx — add connection registry:
const activeConnections = useRef<Map<string, { disconnect: () => void }>>(new Map())

// In connectToPeer wrapper:
const { disconnect } = await connectToPeer(...)
activeConnections.current.set(pubkey, { disconnect })

// In cleanup:
return () => {
  for (const [, conn] of activeConnections.current) {
    conn.disconnect()
  }
  activeConnections.current.clear()
  // ... existing cleanup
}
```

### 3.3 Fix timeout path

In the timeout handler of `connectToPeer`, ensure `socket_disconnected` is called if `descriptor` exists before calling `ws.close()`. The current code calls `ws.close()` which triggers `onclose`, which does check for descriptor — verify this path is correct and add a comment documenting it.

## Phase 4: Security UX (046, 091)

### 4.1 Replace prompt() for mnemonic import (todo 046)

**File:** `src/wallet/wallet-gate.tsx`

Replace `prompt()` with a proper full-page import form. Pattern should match the existing `MnemonicWordGrid` component style.

```typescript
// wallet-gate.tsx — add import state:
const [importMode, setImportMode] = useState(false)
const [importWords, setImportWords] = useState('')

// Replace prompt() call with:
// Show a textarea with type-like masking (CSS text-security or dots toggle)
// Normalize input: lowercase, trim, collapse whitespace
// Validate before calling wallet.importWallet()
// On error: show inline error message with "Try again" button (not page refresh)
```

**Input normalization:**
```typescript
function normalizeMnemonic(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')    // collapse whitespace
    .replace(/[^\w\s]/g, '') // strip punctuation
}
```

### 4.2 Auto-hide seed phrase on Backup page (todo 091)

**File:** `src/pages/Backup.tsx`

Add three protections:
1. A "Done" button that clears state and navigates to `/settings`
2. `visibilitychange` listener that clears the revealed words when tab is hidden
3. Auto-hide timer (60 seconds) with countdown indicator

```typescript
// In Backup.tsx, when status === 'revealed':
useEffect(() => {
  const timer = setTimeout(() => {
    setState({ status: 'warning' }) // back to warning screen
  }, 60_000)

  const handleVisibility = () => {
    if (document.visibilityState === 'hidden') {
      setState({ status: 'warning' })
    }
  }
  document.addEventListener('visibilitychange', handleVisibility)

  return () => {
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', handleVisibility)
  }
}, [])

// Add "Done" button:
<button onClick={() => navigate('/settings')}>Done — Hide Seed Phrase</button>
```

## Phase 5: Broadcaster Improvements (055, 078, 014)

### 5.1 Consolidate broadcast logic (todo 055)

**File:** `src/onchain/tx-bridge.ts`, `src/ldk/traits/broadcaster.ts`

The `tx-bridge.ts` module is marked TEMPORARY (pending upstream `bdk-wasm#38`). Rather than a complex consolidation, inline the tx-bridge broadcast into `event-handler.ts` where it's called, and have both paths use the broadcaster's retry logic.

**Approach:** Have `broadcastWithRetry` from `broadcaster.ts` be importable and used by the event handler's `FundingGenerationReady` handler.

### 5.2 Add inflight dedup guard (todo 078)

**File:** `src/ldk/traits/broadcaster.ts`

Add a `Set<string>` tracking in-flight broadcast hex strings to prevent overlapping retry chains when LDK calls `broadcast_transactions` multiple times for the same tx during an outage.

```typescript
const inflightTxs = new Set<string>()

async function broadcastWithRetry(esploraUrl: string, txHex: string): Promise<void> {
  if (inflightTxs.has(txHex)) {
    console.info('[LDK Broadcaster] Skipping duplicate in-flight broadcast')
    return
  }
  inflightTxs.add(txHex)
  try {
    // ... existing retry logic ...
  } finally {
    inflightTxs.delete(txHex)
  }
}
```

### 5.3 Add TODO comment for retry (todo 014)

This is already addressed by the existing broadcaster retry implementation from the prior P1 plan. Mark as complete — verify the retry logic exists in `broadcaster.ts` and update the todo file status.

## Phase 6: Code Cleanup (005, 006, 007, 012, 013, 015, 028, 029, 048, 049, 058, 059)

**Do all refactoring after behavioral changes are merged to avoid merge conflicts.**

### 6.1 Deduplicate hex utilities (todo 005)

Move `bytesToHex`, `txidBytesToHex`, `hexToBytes` to `src/utils/hex.ts`. Update all imports across `ldk/`, `onchain/`, and `wallet/` modules.

### 6.2 Remove dead code (todos 006, 028, 049)

Consolidate three dead-code cleanup todos into one pass:
- Remove `idbGetAll` if unused
- Remove unused IndexedDB stores from schema
- Remove `getBlockHashAtHeight` from esplora-client
- Remove `networkGraphPersistIntervalTicks` if unused
- Remove unused `use-onchain` hook
- Collapse `SyncStatus` type if redundant
- Use `import type` where applicable
- Remove unused exports from `event-handler.ts`

### 6.3 Add useLdk() guard + barrel export (todo 007)

Add a runtime throw if `useLdk()` is called outside `LdkProvider`. Create `src/ldk/index.ts` barrel.

### 6.4 Zero seed after KeysManager init (todo 012)

**File:** `src/ldk/init.ts`

```typescript
const keysManager = KeysManager.constructor_new(seed, startupTimeSecs, startupTimeNanos)
seed.fill(0) // Zero seed bytes after KeysManager copies them
```

### 6.5 Simplify fee estimator nearest-block search (todo 013)

Replace the over-engineered nearest-block search loop with a direct `Map.get()` and fallback to minimum fee rate.

### 6.6 WASM integrity verification (todo 015)

Add SHA-256 check of the LDK WASM binary during `initWasm()`. Block startup on verification failure.

### 6.7 Extract init helpers and split sync loop (todo 029)

Refactor `init.ts` to extract `restoreChannelMonitors()`, `createPeerManager()`, etc. into named helpers. Replace the 8-positional-arg `startSyncLoop` call with an options object.

### 6.8 Move IDB module to shared location (todo 048)

Move `src/ldk/storage/idb.ts` → `src/storage/idb.ts`. Update ~15 import paths.

### 6.9 Add error handling to generateAddress (todo 058)

**File:** `src/pages/Receive.tsx`

Wrap `generateAddress()` in try/catch, set error state, show inline error message.

### 6.10 Add QR URI format test (todo 059)

Add a test verifying the BIP21 URI in the QR code uses uppercase `BITCOIN:` prefix and uppercase address (BIP21 spec for QR).

## Acceptance Criteria

### Phase 1: Esplora Hardening
- [x] All Esplora fetch calls have 10s timeout via `AbortSignal.timeout()`
- [x] `hexToBytes` throws on invalid hex characters
- [x] `getTipHeight` validates integer response
- [x] `getTipHash` validates 64-char hex response
- [x] JSON endpoints have minimal shape validation before `as T` cast

### Phase 2: Sync Loop
- [x] Watched txid and output checks run in parallel via `Promise.allSettled`
- [x] Sync loop has capped exponential backoff (30s → 5min cap)
- [x] `syncStatus` transitions: syncing → synced → stale (after 3 failures)
- [x] Confirmed items pruned from WatchState maps after LDK no longer tracks them
- [x] `visibilitychange` handler triggers best-effort CM/NG/Scorer persist

### Phase 3: WebSocket
- [x] `connectToPeer` returns a `disconnect` handle
- [x] Active connections tracked in LDK context and cleaned up on unmount
- [x] Timeout path documented re: `socket_disconnected` call chain

### Phase 4: Security UX
- [x] Mnemonic import uses a proper form instead of `prompt()`
- [x] Import input is normalized (lowercase, trim, collapse whitespace)
- [x] Import error shows inline retry, not page refresh
- [x] Backup page auto-hides seed after 60s
- [x] Backup page clears seed on `visibilitychange` (tab hidden)
- [x] Backup page has "Done" button navigating to `/settings`

### Phase 5: Broadcaster
- [x] `broadcastWithRetry` is importable for use in event-handler
- [x] Inflight dedup `Set` prevents overlapping retry chains
- [x] Todo 014 marked complete (retry already implemented)

### Phase 6: Cleanup
- [ ] Hex utilities in `src/utils/hex.ts`, all imports updated
- [x] Dead code removed across esplora-client, config, init, event-handler
- [ ] `useLdk()` throws outside provider (skipped — guard breaks test pattern)
- [x] Seed zeroed after KeysManager init
- [x] Fee estimator simplified to direct lookup + default
- [ ] WASM SHA-256 verification on startup (deferred — needs hash of WASM binary)
- [ ] `startSyncLoop` uses options object (already uses SyncLoopConfig object)
- [ ] IDB module at `src/storage/idb.ts` (deferred — 15+ import path changes)
- [x] `generateAddress()` has error handling in Receive.tsx
- [x] QR URI format test added

## Implementation Order

```
Phase 1 (Esplora hardening) ──→ Phase 2 (Sync loop) ──→ Phase 3 (WebSocket)
                                                              │
Phase 4 (Security UX) ─── independent, can parallel with ────┘
Phase 5 (Broadcaster) ─── independent, can parallel with Phase 2-3
Phase 6 (Cleanup) ────── after all behavioral changes merged
```

**Suggested PR structure:**
1. PR #1: Phase 1 (Esplora hardening) — small, low risk
2. PR #2: Phase 2 (Sync loop) — largest PR, design-heavy
3. PR #3: Phase 3 (WebSocket cleanup) — medium
4. PR #4: Phase 4 (Security UX) — medium, can parallel with PR #2-3
5. PR #5: Phase 5 (Broadcaster) — small
6. PR #6: Phase 6 (Cleanup) — large but mechanical

## Deferred Items

| # | Todo | Why deferred |
|---|------|-------------|
| 045 | Plaintext mnemonic in IDB | Requires SubtleCrypto encryption layer; overkill for signet |
| 094 | Auth gate before seed reveal | Requires PIN/biometric architecture; signet risk is low |
| 016 | NodeManager singleton | No headless/agent use case yet |
| 072 | Extract onchain service | Depends on 016; no agent consumers exist |

## SpecFlow Analysis: Key Risks

1. **Sync parallelization (025) changes error semantics:** `Promise.allSettled` is required (not `Promise.all`) to allow partial progress when individual Esplora calls fail.
2. **Map pruning (027) timing:** Only prune after checking `get_relevant_txids()` — don't prune on first confirmation (reorgs can un-confirm).
3. **`visibilitychange` persistence (023) is best-effort:** IDB writes may not complete before tab closes. Acceptable — periodic persistence limits data loss window to ~30s.
4. **WebSocket StrictMode re-mount:** Unmount cleanup will disconnect peers, StrictMode re-mount will reconnect. Acceptable for dev; no effect in production.
5. **Hex dedup (005) touches ~15 files:** Do this last to avoid merge conflicts with behavioral changes.

## Housekeeping: Update Already-Fixed Todo Statuses

Several pending-named files already have `status: complete` in frontmatter — these were fixed in prior batches but filenames weren't updated:

| File | Status in frontmatter |
|------|----------------------|
| 001, 002, 003, 004 | `status: complete` ✓ |
| 008, 009, 010, 011 | `status: complete` ✓ |
| 017, 018, 019, 022, 024, 026 | `status: complete` ✓ |
| 031, 032, 033, 034, 035 | `status: complete` ✓ |
| 044, 047 | `status: complete` ✓ |
| 056, 057, 073-077, 081, 083-084, 087, 089, 092-093 | `status: complete` ✓ |

These filenames still say "pending" but the work is done. Consider a bulk rename or leave as-is (frontmatter is authoritative).

## Sources & References

### Internal References
- Prior P1/P2 batch plan: `docs/plans/2026-03-14-003-fix-p1-p2-bugfix-batch-plan.md`
- Persist retry pattern: `src/ldk/traits/persist.ts:19-39`
- Sync loop: `src/ldk/sync/chain-sync.ts`
- Esplora client: `src/ldk/sync/esplora-client.ts`
- Hex utils: `src/ldk/utils.ts`
- Broadcaster: `src/ldk/traits/broadcaster.ts`
- Backup page: `src/pages/Backup.tsx`
- Wallet gate: `src/wallet/wallet-gate.tsx`
- IDB module: `src/ldk/storage/idb.ts`

### Todo Files
- P2: 020, 021, 023, 025, 027, 036, 046, 048, 091
- P3: 005, 006, 007, 012, 013, 014, 015, 028, 029, 030, 049, 055, 058, 059, 078
- Deferred: 045, 094, 016, 072
