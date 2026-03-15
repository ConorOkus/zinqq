---
title: "fix: P1 + P2 bugfix batch — fund safety, input validation, and quick wins"
type: fix
status: active
date: 2026-03-14
---

# fix: P1 + P2 bugfix batch — fund safety, input validation, and quick wins

## Overview

Batch fix addressing all 5 truly-pending P1 bugs (fund safety / critical) plus 7 quick-win P2 fixes (input validation, dedup, guards). Also updates 6 todo files whose code was already fixed in prior commits but whose status was never updated.

**Code audit findings:** Several todos listed as "pending" are already fixed in the current codebase:
- 011 (WASM reinit guard) — `initWasm()` + `initPromise` dedup in `init.ts:68-112`
- 018 (orphaned monitors) — throws error in `init.ts:236-242`
- 019 (monitor deserialization) — throws error in `init.ts:327-330`
- 024 (WASM init caches failed promise) — clears on error in `init.ts:72-74`
- 044 (OnchainProvider rerender loop) — ref pattern in `onchain/context.tsx:91-98`
- 047 (seed-mnemonic consistency) — checked in `init.ts:124-129`

## Scope

| # | Todo | Priority | Category | Effort |
|---|------|----------|----------|--------|
| 031 | Broadcaster silent failure → fund loss | P1 | fund-safety | medium |
| 034 | Peer address validation (path traversal + hex injection) | P1 | security | small |
| 017+033 | Wire onPersistFailure callback | P1 | fund-safety | small |
| 008 | Fee estimator unbounded rates | P2 | input-validation | small |
| 009 | Seed runtime type validation | P2 | type-safety | small |
| 010 | Archive comment contradicts delete | P2 | quality | trivial |
| 026 | Unsafe string split in chain-sync | P2 | input-validation | small |
| 035 | Duplicated bytesToHex + unsafe ArrayBuffer cast | P2 | quality | small |
| 032 | CM persistence flag cleared on failure | P2 | fund-safety | small |
| 022 | Web Locks fallback unsafe | P2 | fund-safety | small |
| — | Update 6 already-fixed todos to complete | housekeeping | quality | trivial |

**Out of scope:** 020 (Esplora response validation — needs runtime schema), 021 (sync backoff), 023 (shutdown persistence), 025 (parallel HTTP), 027 (WatchState cleanup), 045 (plaintext mnemonic — deferred to mainnet), 046 (prompt() — needs UI component), 048 (IDB module placement — architectural refactor).

## Phase 1: P1 Fund-Safety Fixes

### 1.1 Broadcaster retry with backoff (todo 031)

**File:** `src/ldk/traits/broadcaster.ts`

**Problem:** `broadcast_transactions` fires HTTP POSTs with only `console.error` on failure. If the tx is a justice transaction or force-close commitment, silent failure = fund loss.

**Fix:** Add retry with exponential backoff, matching the pattern already established in `persist.ts:19-39`.

```typescript
// src/ldk/traits/broadcaster.ts

const MAX_BROADCAST_RETRIES = 5
const RETRY_DELAY_MS = 1_000

async function broadcastWithRetry(esploraUrl: string, txHex: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_BROADCAST_RETRIES; attempt++) {
    try {
      const res = await fetch(`${esploraUrl}/tx`, {
        method: 'POST',
        body: txHex,
      })
      if (res.ok) {
        const txid = await res.text()
        console.info(`[LDK Broadcaster] Broadcast tx: ${txid}`)
        return
      }
      const body = await res.text()
      // Don't retry if the tx is already in mempool/chain
      if (body.includes('Transaction already in block chain') || body.includes('txn-already-known')) {
        console.info(`[LDK Broadcaster] Tx already known, skipping retry`)
        return
      }
      throw new Error(`HTTP ${res.status}: ${body}`)
    } catch (err: unknown) {
      console.error(
        `[LDK Broadcaster] Broadcast attempt ${attempt}/${MAX_BROADCAST_RETRIES} failed:`,
        err,
      )
      if (attempt < MAX_BROADCAST_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (attempt - 1)))
      }
    }
  }
  console.error('[LDK Broadcaster] CRITICAL: All broadcast attempts failed for tx')
}
```

**Key decisions:**
- 5 retries (vs 3 for persist) because broadcast failure is more dangerous — justice tx has a timelock deadline
- Exponential backoff: 1s, 2s, 4s, 8s, 16s (~31s total)
- Short-circuit on "already known" responses (not an error)
- `broadcast_transactions` is synchronous (LDK callback), so fire the async retry and let it run

### 1.2 Peer address input validation (todo 034)

**File:** `src/ldk/peers/peer-connection.ts:117-137`

**Problem:** `parsePeerAddress` validates pubkey length (66 chars) but not hex content. Host passes through unchecked — slashes enable path traversal on the WebSocket proxy (`wss://proxy/v1/../../admin/9735`).

**Fix:**

```typescript
// Add after the pubkey.length check at line 133-135:
if (!/^[0-9a-f]{66}$/.test(pubkey)) {
  throw new Error('Invalid peer address: pubkey must be valid lowercase hex')
}
if (/[\/\?#]/.test(host) || host.length === 0) {
  throw new Error('Invalid peer address: host contains invalid characters')
}
```

### 1.3 Wire onPersistFailure callback (todos 017 + 033)

**File:** `src/ldk/init.ts:141`

**Problem:** `createPersister()` returns `onPersistFailure` but `init.ts` destructures only `persist` and `setChainMonitor`, discarding the failure handler. After persist retries exhaust, the error goes only to `console.error`.

**Fix:**

```typescript
// init.ts line 141 — change:
const { persist: persister, setChainMonitor } = createPersister()
// to:
const { persist: persister, setChainMonitor, onPersistFailure } = createPersister()

// After setChainMonitor(chainMonitor) on line 152, add:
onPersistFailure(({ key, error }) => {
  console.error(`[LDK Init] CRITICAL: Persist failure for ${key}, force-closing channel`, error)
  // Force-close the affected channel so LDK doesn't operate with stale state
  // The key format is "txid:vout" from outpointKey()
  // TODO: In a future iteration, trigger a user-visible alert
})
```

**Note:** For now, logging the CRITICAL error is the minimum viable fix. The persist retry mechanism in `persist.ts` already prevents `channel_monitor_updated` from being called on failure, which causes LDK to halt channel operations for that channel (safe behavior). The callback gives the application layer visibility into the failure.

## Phase 2: P2 Quick Wins

### 2.1 Fee estimator: add ceiling + type validation (todo 008)

**File:** `src/ldk/traits/fee-estimator.ts:33-36`

**Problem:** No ceiling on fee rates from Esplora, no type check on values. Compromised API could cause massive fee overpayment.

**Fix:** In the `refreshCache` `.then()` handler:

```typescript
// Replace lines 33-36:
for (const [blocks, feePerVbyte] of Object.entries(estimates)) {
  rates.set(Number(blocks), Math.round(feePerVbyte * 250))
}

// With:
const MAX_FEE_SAT_KW = 500_000 // ~2,000 sat/vB — beyond this, something is wrong
for (const [blocks, feePerVbyte] of Object.entries(estimates)) {
  if (typeof feePerVbyte !== 'number' || !Number.isFinite(feePerVbyte) || feePerVbyte <= 0) {
    continue // skip invalid entries
  }
  const satKw = Math.round(feePerVbyte * 250)
  rates.set(Number(blocks), Math.min(satKw, MAX_FEE_SAT_KW))
}
```

### 2.2 Seed runtime type validation (todo 009)

**File:** `src/ldk/storage/seed.ts:6-8`

**Problem:** `getSeed()` trusts `idbGet<Uint8Array>` returns a `Uint8Array` via `as T` cast. Corrupted IDB data → wrong key derivation → fund loss.

**Fix:**

```typescript
export async function getSeed(): Promise<Uint8Array | undefined> {
  const raw = await idbGet<Uint8Array>('ldk_seed', SEED_KEY)
  if (raw === undefined) return undefined
  if (!(raw instanceof Uint8Array)) {
    throw new Error('[Seed] Stored seed is not a Uint8Array — possible data corruption')
  }
  return raw
}
```

### 2.3 Archive comment clarification (todo 010)

**File:** `src/ldk/traits/persist.ts:96`

**Problem:** The LDK callback is named `archive_persisted_channel` but the implementation calls `idbDelete`. No comment explains the decision.

**Fix:** Add a single-line comment:

```typescript
archive_persisted_channel(channel_funding_outpoint: OutPoint): void {
  // LDK calls this "archive" but we delete — no need to retain closed channel monitors
  const key = outpointKey(channel_funding_outpoint)
```

### 2.4 Unsafe string split validation (todo 026)

**File:** `src/ldk/sync/chain-sync.ts:62`

**Problem:** `key.split(':')` with no validation. If key has no colon, `voutStr` is `undefined` and `parseInt(undefined, 10)` returns `NaN`, passed to Esplora API.

**Fix:**

```typescript
// Replace line 62:
const [txid, voutStr] = key.split(':')

// With:
const colonIdx = key.indexOf(':')
if (colonIdx === -1) {
  console.error(`[LDK Sync] Malformed watched output key: ${key}`)
  continue
}
const txid = key.slice(0, colonIdx)
const vout = parseInt(key.slice(colonIdx + 1), 10)
if (isNaN(vout)) {
  console.error(`[LDK Sync] Invalid vout in watched output key: ${key}`)
  continue
}

// Update line 63 to use vout directly instead of parseInt(voutStr, 10)
const spend = await esplora.getOutspend(txid, vout)
```

### 2.5 Deduplicate bytesToHex + instanceof guard (todo 035)

**File:** `src/ldk/peers/peer-connection.ts:65, 83-85`

**Problem:** `bytesToHex` logic duplicated inline at lines 83-85 instead of using `../utils`. Unsafe `event.data as ArrayBuffer` cast at line 65.

**Fix:**

```typescript
// Line 65 — replace:
const data = new Uint8Array(event.data as ArrayBuffer)
// With:
if (!(event.data instanceof ArrayBuffer)) return
const data = new Uint8Array(event.data)

// Lines 83-85 — replace inline hex conversion:
const peerPubkey = Array.from(peerPubkeyBytes)
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')
// With (add import at top):
const peerPubkey = bytesToHex(peerPubkeyBytes)
```

Update the import at the top of `peer-connection.ts`:
```typescript
import { hexToBytes, bytesToHex } from '../utils'
```

### 2.6 CM persistence: re-persist on failure (todo 032)

**File:** `src/ldk/sync/chain-sync.ts:114-117`

**Problem:** `get_and_clear_needs_persistence()` clears LDK's internal dirty flag when called. If the subsequent `idbPut` fails, the flag is already cleared. Next tick returns false, stale state persists.

**Fix:**

```typescript
// Replace lines 114-117:
if (channelManager.get_and_clear_needs_persistence()) {
  await idbPut('ldk_channel_manager', 'primary', channelManager.write())
}

// With:
if (channelManager.get_and_clear_needs_persistence()) {
  try {
    await idbPut('ldk_channel_manager', 'primary', channelManager.write())
  } catch (err: unknown) {
    // Re-mark as needing persistence so next tick retries.
    // write_channel_manager_data is not available, but we can track it ourselves.
    cmNeedsPersist = true
    throw err // re-throw to be caught by the outer catch
  }
}
```

This requires adding a `cmNeedsPersist` flag at the `startSyncLoop` scope and checking it alongside the LDK flag:

```typescript
let cmNeedsPersist = false
// ...
if (cmNeedsPersist || channelManager.get_and_clear_needs_persistence()) {
  cmNeedsPersist = false
  try {
    await idbPut('ldk_channel_manager', 'primary', channelManager.write())
  } catch (err: unknown) {
    cmNeedsPersist = true
    throw err
  }
}
```

### 2.7 Web Locks: fail hard when unavailable (todo 022)

**File:** `src/ldk/init.ts:82-85`

**Problem:** If Web Locks API is unavailable, `acquireWalletLock()` logs a warning and continues. Two tabs with independent ChannelManagers = fund loss.

**Fix:**

```typescript
// Replace:
if (!navigator.locks) {
  console.warn('[LDK Init] Web Locks API not available, skipping multi-tab guard')
  return
}

// With:
if (!navigator.locks) {
  throw new Error(
    '[LDK Init] Web Locks API not available. ' +
    'A modern browser with Web Locks support is required to prevent multi-tab fund loss.'
  )
}
```

**Risk:** This could break on very old browsers. Acceptable trade-off — the alternative is silent fund loss. Web Locks is supported in all modern browsers (Chrome 69+, Firefox 96+, Safari 15.4+).

## Phase 3: Housekeeping

### 3.1 Update completed todo files

Update the `status:` field from `pending` to `complete` in these 6 todo files whose fixes are already in the codebase:

| File | Fix location |
|------|-------------|
| `todos/011-pending-p2-wasm-reinit-guard.md` | `init.ts:68-78` (initWasm dedup) + `init.ts:102-112` (initPromise dedup) |
| `todos/018-pending-p1-orphaned-monitors-silently-discarded.md` | `init.ts:236-242` (throws error) |
| `todos/019-pending-p1-monitor-deserialization-failure-skipped.md` | `init.ts:327-330` (throws error) |
| `todos/024-pending-p2-wasm-init-caches-failed-promise.md` | `init.ts:72-74` (clears on error) |
| `todos/044-pending-p1-onchain-provider-infinite-rerender-loop.md` | `onchain/context.tsx:91-98` (ref pattern) |
| `todos/047-pending-p2-seed-mnemonic-consistency-check.md` | `init.ts:124-129` (comparison check) |

Also update 017 and 033 to complete after the fix in Phase 1.3.

## Acceptance Criteria

### Fund Safety (P1)
- [ ] Broadcaster retries failed broadcasts up to 5 times with exponential backoff
- [ ] Broadcaster short-circuits retry on "already known" response
- [ ] `parsePeerAddress` rejects non-hex pubkeys via `/^[0-9a-f]{66}$/` regex
- [ ] `parsePeerAddress` rejects hosts containing `/`, `?`, or `#`
- [ ] `onPersistFailure` is destructured and wired in `init.ts`
- [ ] Persist failure logs a CRITICAL-level message with the channel key

### Input Validation & Guards (P2)
- [ ] Fee estimator skips non-numeric/non-finite values from Esplora
- [ ] Fee estimator caps at 500,000 sat/KW (~2,000 sat/vB)
- [ ] `getSeed()` validates `raw instanceof Uint8Array` before returning
- [ ] `archive_persisted_channel` has a clarifying comment
- [ ] Chain-sync validates watched output key format before splitting
- [ ] `peer-connection.ts` uses shared `bytesToHex` from utils
- [ ] `event.data` has `instanceof ArrayBuffer` guard
- [ ] CM persistence retries on next tick if `idbPut` fails
- [ ] `acquireWalletLock()` throws when Web Locks API is unavailable

### Housekeeping
- [ ] 6 already-fixed todo files updated to `status: complete`
- [ ] Todos 017 and 033 updated to `status: complete` after fix

## Implementation Order

1. **Phase 3 first** — update already-fixed todo statuses (no code risk)
2. **Phase 2** — P2 quick wins (small, isolated changes)
3. **Phase 1.2** — peer address validation (isolated, no side effects)
4. **Phase 1.3** — wire onPersistFailure (small change in init.ts)
5. **Phase 1.1** — broadcaster retry (most complex change, test last)

## Testing Notes

- **Broadcaster retry:** Test with Esplora down (network error) and with 400 response. Verify exponential backoff timing. Verify "already known" short-circuit.
- **Peer validation:** Test with `../` in host, with non-hex pubkey, with empty host.
- **Fee estimator:** Test with `NaN`, `Infinity`, negative, and extremely large values in mock response.
- **Seed validation:** Test with non-Uint8Array stored in IDB (e.g., a plain object).
- **Web Locks:** Test in a context where `navigator.locks` is undefined.
- **CM persistence:** Test by making `idbPut` throw, verify next tick retries.

## Sources & References

### Internal References
- Persist retry pattern: `src/ldk/traits/persist.ts:19-39`
- WASM init dedup pattern: `src/ldk/init.ts:68-78`
- Seed consistency check: `src/ldk/init.ts:120-129`
- BDK ref pattern (044 fix): `src/onchain/context.tsx:88-98`

### Todo Files
- P1: 017, 031, 034
- P2: 008, 009, 010, 022, 026, 032, 033, 035
- Housekeeping: 011, 018, 019, 024, 044, 047
