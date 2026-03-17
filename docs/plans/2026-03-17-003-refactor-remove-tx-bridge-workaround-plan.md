---
title: "refactor: Remove tx-bridge workaround (BDK wasm 0.3.0)"
type: refactor
status: completed
date: 2026-03-17
origin: docs/brainstorms/2026-03-12-bdk-ldk-tx-bridge-brainstorm.md
---

# Remove tx-bridge Workaround

## Overview

Delete the temporary `tx-bridge.ts` module now that BDK wasm 0.3.0 exposes `Transaction.to_bytes()` and `Transaction.from_bytes()` ([PR #39](https://github.com/bitcoindevkit/bdk-wasm/pull/39), merged 2026-03-16). Replace its two functions with native BDK APIs and the existing `broadcastWithRetry()` function.

## Problem Statement / Motivation

`tx-bridge.ts` was an intentional workaround (see brainstorm: `docs/brainstorms/2026-03-12-bdk-ldk-tx-bridge-brainstorm.md`) because BDK wasm 0.2.0's `Transaction` type had no serialization methods. It uses `@scure/btc-signer` (~15KB) to parse signed PSBTs and extract raw transaction bytes — an entire third-party dependency for something the upstream library now handles natively.

The module was designed for removal: all functions carry `// TEMPORARY: Remove when bdk-wasm exposes Transaction.to_bytes()` comments, and the code is isolated in a single file.

## Proposed Solution

### Phase 1: Harden broadcastWithRetry() (prerequisite)

Before migrating callers to `broadcastWithRetry()`, fix two gaps discovered by SpecFlow analysis:

**1a. Return txid and throw on total failure**

`broadcastWithRetry()` currently returns `Promise<void>` and silently swallows failures. This is fine for the LDK `BroadcasterInterface` trait (fire-and-forget), but dangerous for sweep.ts and event-handler.ts where the caller deletes IDB entries after broadcast. If broadcast silently fails, spendable output descriptors get deleted — **permanent fund loss**.

Change signature to `Promise<string>` (returns txid on success, throws after exhausting retries). The `BroadcasterInterface` wrapper in `createBroadcaster()` already calls it with `void` and catches nothing, so it is unaffected.

```typescript
// broadcaster.ts

// Before:
export async function broadcastWithRetry(esploraUrl: string, txHex: string): Promise<void>

// After:
export async function broadcastWithRetry(esploraUrl: string, txHex: string): Promise<string>
// Returns txid on success (including idempotent "already known")
// Throws BroadcastError after MAX_BROADCAST_RETRIES failures
```

**1b. Fix idempotency checks**

Add case-insensitive matching and the missing `txn-already-confirmed` sentinel to match `broadcastTransaction()`'s behavior. The funding flow depends on this: after a page reload, `FundingTxBroadcastSafe` may re-broadcast an already-confirmed tx.

```typescript
// Before (case-sensitive, missing check):
if (body.includes('Transaction already in block chain') || body.includes('txn-already-known'))

// After (case-insensitive, complete):
const lower = body.toLowerCase()
if (lower.includes('transaction already in block chain') ||
    lower.includes('txn-already-known') ||
    lower.includes('txn-already-confirmed'))
```

For idempotent "already known" cases, extract the txid from the raw tx hex locally (double-SHA256 of non-witness serialization, reversed) since Esplora doesn't return it in error responses. Or simply compute it from `txHex` before broadcasting:

```typescript
// Compute txid from raw tx hex for logging/return on idempotent success
import { computeTxid } from '../utils'
```

**Files changed:** `src/ldk/traits/broadcaster.ts`

### Phase 2: Bump BDK wasm to 0.3.0

Bump `@bitcoindevkit/bdk-wallet-web` from `^0.2.0` to `^0.3.0` in `package.json`. Run `pnpm install && pnpm typecheck` to surface any breaking changes before making functional changes.

BDK wasm 0.3.0 adds:
- `Transaction.to_bytes(): Uint8Array` — consensus serialization
- `Transaction.from_bytes(bytes: Uint8Array): Transaction` — consensus deserialization

**Files changed:** `package.json`, `pnpm-lock.yaml`

### Phase 3: Replace extractTxBytes in event-handler.ts

In the `FundingGenerationReady` handler, replace the `@scure/btc-signer` PSBT parsing with native BDK extraction:

```typescript
// Before (event-handler.ts ~line 356):
const rawTxBytes = extractTxBytes(psbt.toString())

// After:
const rawTxBytes = psbt.extract_tx().to_bytes()
```

`psbt.extract_tx()` is already used elsewhere in the codebase (`src/onchain/context.tsx:182`), so this is a proven pattern. The returned `Uint8Array` is consensus-encoded, identical to what `@scure/btc-signer` produced.

Remove the `extractTxBytes` import from the file.

**Files changed:** `src/ldk/traits/event-handler.ts`

### Phase 4: Replace broadcastTransaction in event-handler.ts and sweep.ts

**4a. event-handler.ts — broadcastPersistedFundingTx()**

Replace the `broadcastTransaction(txHex, esploraUrl)` call in `broadcastPersistedFundingTx()` with `broadcastWithRetry(esploraUrl, txHex)`. Note the argument order is reversed.

```typescript
// Before:
const txid = await broadcastTransaction(txHex, ONCHAIN_CONFIG.esploraUrl)

// After:
const txid = await broadcastWithRetry(ONCHAIN_CONFIG.esploraUrl, txHex)
```

Remove the `broadcastTransaction` import. Add `broadcastWithRetry` import from `./broadcaster`.

**4b. sweep.ts**

Same replacement:

```typescript
// Before (sweep.ts ~line 124):
const txid = await broadcastTransaction(txHex, esploraUrl)

// After:
const txid = await broadcastWithRetry(esploraUrl, txHex)
```

Remove the `broadcastTransaction` import from `../onchain/tx-bridge`. Add `broadcastWithRetry` import from `./traits/broadcaster`.

**Files changed:** `src/ldk/traits/event-handler.ts`, `src/ldk/sweep.ts`

### Phase 5: Delete tx-bridge and remove @scure/btc-signer

1. Delete `src/onchain/tx-bridge.ts`
2. Delete `src/onchain/tx-bridge.test.ts`
3. Remove `@scure/btc-signer` from `package.json` dependencies (confirmed: no other files import it)
4. Run `pnpm install` to update lockfile

**Files deleted:** `src/onchain/tx-bridge.ts`, `src/onchain/tx-bridge.test.ts`
**Files changed:** `package.json`, `pnpm-lock.yaml`

### Phase 6: Update tests

**event-handler.test.ts:**
- Remove the `../../onchain/tx-bridge` mock (~lines 190-195)
- Add mock for `./broadcaster` (`broadcastWithRetry`)
- Update `mockPsbt` to expose `extract_tx()`:
  ```typescript
  const mockPsbt = {
    extract_tx: () => ({ to_bytes: () => new Uint8Array([0xde, 0xad]) }),
    toString: () => 'base64psbt',
    // ... existing mock fields
  }
  ```
- Update FundingGenerationReady assertion: verify `extract_tx().to_bytes()` was called (not `mockExtractTxBytes`)
- Update FundingTxBroadcastSafe assertion: verify `broadcastWithRetry` was called (not `mockBroadcastTransaction`)

**broadcaster.test.ts (if exists):**
- Add tests for the new return-txid behavior
- Add tests for case-insensitive idempotency matching
- Add test for throw-after-retries behavior

**Files changed:** `src/ldk/traits/event-handler.test.ts`, `src/ldk/traits/broadcaster.test.ts`

### Phase 7: Clean up docs

Delete documentation that was written specifically for the tx-bridge workaround:
- `docs/solutions/integration-issues/bdk-ldk-cross-wasm-transaction-bridge.md`
- `docs/solutions/integration-issues/bdk-psbt-already-finalized-scure-extract.md`
- `docs/brainstorms/2026-03-12-bdk-ldk-tx-bridge-brainstorm.md`
- `docs/plans/2026-03-12-005-feat-bdk-ldk-tx-bridge-workaround-plan.md`

Close or mark resolved: `todos/055-pending-p3-consider-broadcasttx-consolidation.md` (the two broadcast paths are now consolidated).

## System-Wide Impact

- **Interaction graph**: `FundingGenerationReady` → `psbt.extract_tx().to_bytes()` → `funding_transaction_generated()` → IDB persist → `FundingTxBroadcastSafe` → `broadcastWithRetry()` → IDB delete. `SpendableOutputs` → `spend_spendable_outputs()` → `broadcastWithRetry()` → IDB delete. The `BroadcasterInterface` trait wrapper is unaffected (already uses `broadcastWithRetry`).
- **Error propagation**: After Phase 1, `broadcastWithRetry()` will throw on total failure, preventing IDB deletion of unbroadcast transactions. The `createBroadcaster()` wrapper uses `void broadcastWithRetry(...)` which swallows the rejection — this is correct since the LDK trait is fire-and-forget.
- **State lifecycle risks**: The IDB `ldk_funding_txs` store persists hex between events. The hex format doesn't change (both `@scure/btc-signer` and BDK produce consensus-encoded bytes). Users with pending funding txs in IDB during upgrade will be unaffected.
- **API surface parity**: After this change, all broadcast paths use `broadcastWithRetry()` except the on-chain send flow which uses BDK's `esplora.broadcast(tx)`. This is a clean separation: BDK-originated txs use BDK broadcast, LDK-originated txs use raw Esplora POST.

## Acceptance Criteria

- [x] BDK wasm bumped to 0.3.0, `pnpm typecheck` passes
- [x] `extractTxBytes` replaced with `psbt.extract_tx().to_bytes()` in FundingGenerationReady
- [x] `broadcastTransaction` replaced with `broadcastWithRetry` in event-handler.ts and sweep.ts
- [x] `broadcastWithRetry` returns txid on success, throws after exhausting retries
- [x] `broadcastWithRetry` idempotency checks are case-insensitive and include `txn-already-confirmed`
- [x] `tx-bridge.ts` and `tx-bridge.test.ts` deleted
- [x] `@scure/btc-signer` removed from package.json
- [x] event-handler.test.ts mocks updated and passing
- [ ] broadcaster.test.ts covers new return/throw behavior
- [x] Related docs cleaned up
- [ ] Channel funding flow works end-to-end (manual or integration test)
- [ ] Sweep flow works when spendable outputs exist

## Dependencies & Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| BDK 0.3.0 has other breaking changes | Medium | Phase 2 is isolated: bump + typecheck before functional changes |
| `broadcastWithRetry` throw breaks LDK BroadcasterInterface | Low | Wrapper uses `void` which swallows rejections; add test |
| Mid-upgrade IDB compat (pending funding tx) | Low | Both libs produce identical consensus-encoded bytes |
| Sweep fund loss from silent broadcast failure | **Critical** | Phase 1 prerequisite: make broadcastWithRetry throw on failure |

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-03-12-bdk-ldk-tx-bridge-brainstorm.md](docs/brainstorms/2026-03-12-bdk-ldk-tx-bridge-brainstorm.md) — Key decisions: isolated bridge module, `@scure/btc-signer` for PSBT parsing, designed for removal
- **Upstream PR:** [bitcoindevkit/bdk-wasm#39](https://github.com/bitcoindevkit/bdk-wasm/pull/39) — adds `Transaction.to_bytes()` and `from_bytes()`
- **Upstream issue:** [bitcoindevkit/bdk-wasm#38](https://github.com/bitcoindevkit/bdk-wasm/issues/38) — the gap this workaround addressed
- **Existing pattern:** `src/onchain/context.tsx:182` — already uses `psbt.extract_tx()` + `esplora.broadcast(tx)`
- **Broadcast consolidation TODO:** `todos/055-pending-p3-consider-broadcasttx-consolidation.md`
