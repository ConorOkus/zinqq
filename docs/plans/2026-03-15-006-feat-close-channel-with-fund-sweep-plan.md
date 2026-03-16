---
title: "feat: Close Channel with Fund Sweep to Onchain Wallet"
type: feat
status: active
date: 2026-03-15
---

# feat: Close Channel with Fund Sweep to Onchain Wallet

## Overview

Implement Lightning channel closing (both cooperative and force close) with automatic sweeping of `SpendableOutputs` back to the onchain BDK wallet. This closes the channel lifecycle loop: users can open channels, transact, and reclaim funds on-chain when done.

The Close Channel screen is accessed from Settings > Advanced (where a placeholder already exists with `route: null`). The sweep of spendable outputs is the critical missing piece — currently `Event_SpendableOutputs` only persists descriptors to IDB but never builds or broadcasts a sweep transaction.

## Problem Statement / Motivation

Users who open Lightning channels currently have no way to close them and reclaim their on-chain funds. The `Event_SpendableOutputs` handler persists output descriptors to IndexedDB but never sweeps them — funds are effectively stranded. Both cooperative close (peer agrees) and force close (unilateral, for unresponsive peers) must be supported, along with handling remote-initiated force closes.

## Proposed Solution

### 1. Sweep Module (`src/ldk/sweep.ts`)

The core deliverable. Builds and broadcasts a transaction that spends LDK's `SpendableOutputDescriptor`s to a BDK receive address.

**Approach:** Use `KeysManager.spend_spendable_outputs(descriptors, outputs, change_destination_script, feerate_sat_per_1000_weight)` if available in the WASM bindings — this handles all descriptor types (StaticOutput, DelayedPaymentOutput, StaticPaymentOutput), key derivation, and signing internally. Falls back to manual construction with `@scure/btc-signer` only if the WASM method is unavailable.

```typescript
// src/ldk/sweep.ts (sketch)
import { idbGetAll, idbDelete } from './storage/idb'
import { SpendableOutputDescriptor } from 'lightningdevkit'
import { broadcastTransaction } from '../onchain/tx-bridge'

export async function sweepSpendableOutputs(
  keysManager: KeysManager,
  bdkWallet: Wallet,
  esploraUrl: string,
): Promise<{ swept: number; skipped: number }> {
  const entries = await idbGetAll<Uint8Array[]>('ldk_spendable_outputs')
  if (entries.size === 0) return { swept: 0, skipped: 0 }

  // Deserialize all descriptors, batch into one sweep tx
  const allDescriptors: SpendableOutputDescriptor[] = []
  const idbKeys: string[] = []
  for (const [key, serializedArray] of entries) {
    const descriptors = serializedArray.map(bytes =>
      SpendableOutputDescriptor.constructor_read(bytes)
    )
    allDescriptors.push(...descriptors)
    idbKeys.push(key)
  }

  // Generate BDK receive address as sweep destination
  const addressInfo = bdkWallet.reveal_next_address(KeychainKind.External)
  const destinationScript = addressInfo.address.script_pubkey()

  // Fetch fee rate from Esplora (6-block target, floor 1 sat/vB)
  const feeRate = await fetchFeeRate(esploraUrl)

  // Build + sign sweep tx via LDK's KeysManager
  const sweepTx = keysManager.spend_spendable_outputs(
    allDescriptors,
    [], // no additional outputs
    destinationScript.to_bytes(),
    feeRate * 250, // convert sat/vB to sat/kw
  )

  // Broadcast, then delete IDB entries
  const txHex = bytesToHex(sweepTx)
  await broadcastTransaction(txHex, esploraUrl)
  for (const key of idbKeys) {
    await idbDelete('ldk_spendable_outputs', key)
  }

  // Persist BDK wallet state
  const changeset = bdkWallet.take_staged()
  if (changeset && !changeset.is_empty()) {
    await putChangeset(changeset.to_json())
  }

  return { swept: allDescriptors.length, skipped: 0 }
}
```

**Dust threshold:** Skip sweep if total output value < 546 sats (uneconomical). Log a warning and clean up IDB.

**Idempotency:** Modify `broadcastTransaction` in `tx-bridge.ts` to not throw on "Transaction already in block chain" / "txn-already-known" responses — return the txid instead.

### 2. Event Handler Enhancements (`src/ldk/traits/event-handler.ts`)

**`Event_SpendableOutputs` (line 204):** After persisting to IDB (keep existing behavior), immediately trigger an async sweep attempt if BDK wallet is available:

```typescript
if (event instanceof Event_SpendableOutputs) {
  // Persist first (existing behavior)
  const key = crypto.randomUUID()
  const serialized = event.outputs.map((o) => o.write())
  void idbPut('ldk_spendable_outputs', key, serialized)
    .then(() => {
      // Attempt immediate sweep
      if (bdkWallet) {
        return sweepSpendableOutputs(keysManager, bdkWallet, esploraUrl)
      }
    })
    .catch((err) => {
      console.error('[LDK Event] CRITICAL: SpendableOutputs persist/sweep failed:', err)
    })
}
```

**`Event_ChannelClosed` (line 189):** Add callback notification to UI:

```typescript
if (event instanceof Event_ChannelClosed) {
  const channelIdHex = bytesToHex(event.channel_id.write())
  console.log('[LDK Event] ChannelClosed:', channelIdHex, 'reason:', event.reason)
  onChannelEvent?.({ type: 'closed', channelId: channelIdHex, reason: event.reason })
}
```

### 3. Startup Sweep Recovery

After both LDK and BDK are initialized in the context provider (`src/ldk/context.tsx`), scan `ldk_spendable_outputs` and attempt to sweep all unswept entries. This handles the crash-between-persist-and-broadcast scenario.

Wire this into the `setBdkWallet` flow — when the BDK wallet becomes available, trigger a sweep of any pending outputs.

### 4. Context Methods (`src/ldk/ldk-context.ts` + `src/ldk/context.tsx`)

Add to the `'ready'` variant of `LdkContextValue`:

```typescript
closeChannel: (channelId: Uint8Array, counterpartyNodeId: Uint8Array) => boolean
forceCloseChannel: (channelId: Uint8Array, counterpartyNodeId: Uint8Array) => boolean
listChannels: () => ChannelDetails[]
```

Implementation in `context.tsx` following the `createChannel` pattern:

```typescript
const closeChannel = useCallback(
  (channelId: Uint8Array, counterpartyNodeId: Uint8Array): boolean => {
    if (!nodeRef.current) throw new Error('Node not initialized')
    const result = nodeRef.current.channelManager.close_channel(
      channelId, counterpartyNodeId,
    )
    return result.is_ok()
  }, [],
)

const forceCloseChannel = useCallback(
  (channelId: Uint8Array, counterpartyNodeId: Uint8Array): boolean => {
    if (!nodeRef.current) throw new Error('Node not initialized')
    const result = nodeRef.current.channelManager
      .force_close_broadcasting_latest_txn(channelId, counterpartyNodeId)
    return result.is_ok()
  }, [],
)
```

### 5. Close Channel Page (`src/pages/CloseChannel.tsx`)

State machine following the `OpenChannel.tsx` pattern:

```typescript
type CloseChannelStep =
  | { step: 'select-channel' }
  | { step: 'confirm'; channel: ChannelInfo; closeType: 'cooperative' | 'force' }
  | { step: 'success'; closeType: 'cooperative' | 'force' }
  | { step: 'error'; message: string; canForceClose?: boolean; channel?: ChannelInfo }
```

**Select Channel screen:**
- List all open channels from `channelManager.list_channels()`
- Each card shows: status badge, capacity (sats), truncated peer pubkey, local/remote balance bar, "Close Channel" button
- Follows the design prototype in `design/index.html:346-373`

**Confirm screen:**
- Channel details summary (peer, capacity, local/remote balance)
- Toggle between Cooperative Close (default) and Force Close
- Force close shows a warning: "Force close broadcasts your latest commitment transaction. Funds will be locked for ~144 blocks before they can be swept to your wallet."
- Confirm button (red/destructive styling for force close)

**Success screen:**
- Cooperative: "Channel closing. Funds will return to your wallet once the closing transaction confirms."
- Force: "Force close initiated. Funds will be available after the timelock expires (~144 blocks)."

**Error screen:**
- If cooperative close fails (peer offline), show error with "Force Close Instead" button
- Generic errors show "Try Again" button

### 6. Routing & Navigation

- Add route: `{ path: 'settings/advanced/close-channel', element: <CloseChannel /> }` in `src/routes/router.tsx`
- Update `Advanced.tsx` line 27: `route: '/settings/advanced/close-channel'`

## Technical Considerations

### Fund Safety

- **Sweep is the critical path.** If `Event_SpendableOutputs` fires but sweep fails/crashes, the startup recovery mechanism must catch it. IDB entries are only deleted after successful broadcast.
- **Persist before broadcast:** Follow the pattern from `bdk-wasm-onchain-send-patterns.md` — persist wallet changeset AFTER broadcast, not before.
- **ChannelManager state flush:** After `close_channel()` / `force_close_broadcasting_latest_txn()`, the 10s event loop already flushes CM state if `get_and_clear_needs_persistence()` is true.

### Broadcast Idempotency

Modify `broadcastTransaction` in `src/onchain/tx-bridge.ts` to treat "already in block chain" / "txn-already-known" responses as success rather than throwing. This prevents infinite retry loops during startup recovery.

### Force Close Timelock

After force close, `Event_SpendableOutputs` will not fire until the CSV delay expires (configured per channel, typically 144 blocks). LDK's chain sync will detect when the timelock matures and emit the event. No special handling needed beyond the existing sync loop — just patience and user communication.

### Anchor Channels (Future)

`Event_BumpTransaction` is currently unimplemented (event-handler.ts:306). If channels use anchor outputs, force close requires CPFP fee bumping. This is out of scope for this feature but should be documented as a known limitation.

### Dependencies Needed

- `keysManager` must be accessible to the sweep module (currently only in `init.ts` scope — pass through event handler or context)
- `bdkWallet` reference already available in event handler via `setBdkWallet()`
- Esplora URL available via `SIGNET_CONFIG.esploraUrl` / `ONCHAIN_CONFIG.esploraUrl`

## Acceptance Criteria

### Core Functionality

- [ ] User can initiate cooperative close from the Close Channel screen (`src/pages/CloseChannel.tsx`)
- [ ] User can initiate force close from the Close Channel screen
- [ ] `closeChannel` and `forceCloseChannel` methods exposed on `LdkContextValue` (`src/ldk/ldk-context.ts`)
- [ ] `listChannels` method exposed on `LdkContextValue` returning channel details (id, peer, balances, status)
- [ ] Close Channel route wired at `/settings/advanced/close-channel` (`src/routes/router.tsx`)
- [ ] Advanced settings item navigates to Close Channel (`src/pages/Advanced.tsx`, line 27)

### Sweep Implementation

- [ ] New sweep module at `src/ldk/sweep.ts` using `KeysManager.spend_spendable_outputs()` (or manual fallback)
- [ ] `Event_SpendableOutputs` handler triggers immediate async sweep after IDB persist (`src/ldk/traits/event-handler.ts`)
- [ ] Startup recovery: sweep all pending `ldk_spendable_outputs` entries when BDK wallet becomes available
- [ ] IDB entries deleted only after successful broadcast
- [ ] Dust outputs (< 546 sats) skipped with warning log
- [ ] Multiple descriptor sets batched into single sweep transaction

### Broadcast Robustness

- [ ] `broadcastTransaction` in `src/onchain/tx-bridge.ts` handles "already in chain" as success (idempotent)
- [ ] Fee rate fetched from Esplora `/fee-estimates` (6-block target, floor 1 sat/vB)

### UI/UX

- [ ] Channel list shows all open channels with local/remote balance bars (matching design prototype)
- [ ] Confirmation screen with cooperative/force toggle
- [ ] Force close shows timelock warning
- [ ] Failed cooperative close offers "Force Close Instead" option
- [ ] Success screen with close-type-appropriate messaging
- [ ] Zero-local-balance channels can still be closed (no sweep needed)

### Edge Cases

- [ ] Remote-initiated force close: sweep happens automatically via event handler (no UI action required)
- [ ] Browser crash recovery: startup sweep catches any persisted-but-unswept outputs
- [ ] Multiple simultaneous channel closes handled (each generates independent SpendableOutputs)
- [ ] Double-submit guard on close confirmation (useRef pattern)

## Success Metrics

- Channel close completes and funds appear in onchain wallet balance after confirmation(s)
- Startup recovery successfully sweeps outputs persisted from a previous session
- Cooperative close falls back gracefully to force close when peer is unresponsive

## Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `spend_spendable_outputs()` not available in WASM bindings | Medium | High — requires manual tx construction with @scure/btc-signer | Check WASM bindings first; manual fallback is viable but more complex |
| Anchor channels need BumpTransaction handling | Low (current channels likely non-anchor) | Medium — force close tx stuck without CPFP | Document as known limitation; implement later |
| Event_SpendableOutputs lost before IDB write | Very Low (~10ms window) | High — permanent fund loss | Startup recovery + consider WAL pattern if risk is unacceptable |
| Sweep fee rate too low for timely confirmation | Low | Medium — slow confirmation | Use Esplora estimates; can manually rebroadcast with higher fee later |

## Sources & References

### Internal References

- Event handler: `src/ldk/traits/event-handler.ts:204-221` (SpendableOutputs), `:189-197` (ChannelClosed)
- LDK context: `src/ldk/context.tsx:46-75` (createChannel pattern to follow)
- Context types: `src/ldk/ldk-context.ts:13-32` (LdkContextValue ready variant)
- Tx bridge: `src/onchain/tx-bridge.ts` (extractTxBytes, broadcastTransaction)
- Open channel page: `src/pages/OpenChannel.tsx` (UI state machine pattern)
- Advanced settings: `src/pages/Advanced.tsx:17-27` (Close Channel placeholder)
- Router: `src/routes/router.tsx` (add new route)
- Design prototype: `design/index.html:346-373` (Close Channel screen mockup)

### Documented Learnings

- `docs/solutions/integration-issues/ldk-event-handler-patterns.md` — sync/async bridge, fund-safety patterns
- `docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md` — broadcaster retry, CM persist retry
- `docs/solutions/integration-issues/bdk-ldk-cross-wasm-transaction-bridge.md` — tx-bridge workaround
- `docs/solutions/integration-issues/bdk-wasm-onchain-send-patterns.md` — persist after broadcast, pause sync loop

### Brainstorms

- `docs/brainstorms/2026-03-12-bdk-ldk-tx-bridge-brainstorm.md` — sweep pattern: BDK address + scure tx + bridge broadcast
- `docs/brainstorms/2026-03-11-channel-manager-brainstorm.md` — CM persistence, event processing architecture
