---
title: "feat: LSPS2 JIT channel receive support"
type: feat
status: completed
date: 2026-03-28
origin: docs/brainstorms/2026-03-28-lsps2-jit-channels-brainstorm.md
---

# feat: LSPS2 JIT channel receive support

## Enhancement Summary

**Deepened on:** 2026-03-28
**Sections enhanced:** All phases, architecture, acceptance criteria
**Research agents used:** TypeScript reviewer, Security sentinel, Performance oracle, Race condition reviewer, Architecture strategist, Pattern recognition specialist, Code simplicity reviewer, Learnings researcher, WASM API investigator, LSPS2 reference implementation researcher

### Key Improvements
1. **Critical: Outbound message flush** -- Must call `peerManager.process_events()` after queuing LSPS2 messages, otherwise 10s stall between get_info response and buy request
2. **Critical: Promise timeout reaper** -- Pending promises need 30s timeout to prevent indefinite UI hangs
3. **Scope reduction for v1** -- Cut variable-amount invoices, valid_until auto-refresh, and fee params caching from context to reduce complexity ~15-20%
4. **Security hardening** -- u64 overflow checks in fee calc, unrecognized field rejection, message size guard, payment bounds validation
5. **Race condition mitigation** -- State machine for Receive page, AbortSignal for cancelled requests, visibilitychange handler

### New Considerations Discovered
- Outbound message queue is not flushed by `drainEventsAndRefresh()` -- explicit `process_events()` call required after each LSPS2 message send
- `user_channel_id` must use 8 random bytes (not 16) to avoid LDK WASM u128 encoding bug
- Use `bytesToHex(counterparty_node_id)` for LSP pubkey comparison, never `.write()` (institutional learning)
- Pre-connect to LSP at startup to eliminate 1-3s from first JIT negotiation

---

## Overview

Implement LSPS2 (bLIP-52) client support so zinqq users with zero existing channels can receive their first Lightning payment. When someone pays a zinqq user, the configured LSP intercepts the payment, opens a JIT (Just-In-Time) 0-conf channel, and forwards the payment minus an opening fee. This is the key UX unlock for new wallet onboarding -- no on-chain funding or manual channel management required.

(see brainstorm: docs/brainstorms/2026-03-28-lsps2-jit-channels-brainstorm.md)

## Problem Statement / Motivation

Currently, a new zinqq user must:
1. Receive on-chain bitcoin
2. Open a channel manually
3. Wait for confirmations
4. Only then can they receive Lightning payments

This is a terrible onboarding experience. LSPS2 eliminates steps 1-3 entirely -- the user just shares an invoice and everything happens automatically.

## Proposed Solution

Build a TypeScript LSPS2 client that implements the full JSON-RPC protocol over LDK's `CustomMessageHandler` interface. The LSPS2 WASM types exist in `lightningdevkit@0.1.8-0` but `LiquidityManager` (the compositor) is not exported, and `LSPS2ClientHandler` has no public constructor. Therefore, we implement the protocol directly in TypeScript using `RawLSPSMessage` for wire serialization and `CustomMessageHandler.new_impl()` for PeerManager integration.

**Migration note:** When LDK WASM bindings export `LiquidityManager`, replace the TypeScript LSPS2 protocol handling with `LiquidityManager.as_CustomMessageHandler()`. The context/UI/event-handling layers stay the same. Note: migration also touches `event-handler.ts` for new LSPS2 `Event` variants that `LiquidityManager` surfaces through LDK's standard event system. (see brainstorm: Key Decision 1)

### V1 Scope Reduction

Based on simplicity review, the following are **deferred to v2** to reduce implementation complexity:

- **Variable-amount (no-MPP) invoices** -- v1 requires the user to enter an amount. This simplifies fee calculation (always concrete), invoice generation (always has amount), and UI (always shows exact fee). One code path instead of two.
- **`valid_until` auto-refresh** -- If params expire, the payment fails and the user generates a new invoice. Acceptable UX for an edge case that requires sitting on the Receive page for 10+ minutes.
- **Fee params on global context** -- `lsps2FeeParams` is internal to `requestJitInvoice()`, not observable by UI. Prevents unnecessary global re-renders.
- **Error 201 auto-retry** -- Surface the error; user retries manually from Receive page.

## Technical Approach

### Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Receive UI  │────>│   LdkContext     │────>│  LSPS2Client    │
│  (React)     │     │  (lsps2 methods) │     │  (state machine)│
└──────────────┘     └──────────────────┘     └────────┬────────┘
                                                       │
                     ┌──────────────────┐     ┌────────▼────────┐
                     │  PeerManager     │<────│  LspsMessage    │
                     │                  │     │  Handler        │
                     └──────────────────┘     │  (CustomMsg)    │
                                              └─────────────────┘
```

**Key components:**

1. **`createLspsMessageHandler()`** (`src/ldk/lsps2/message-handler.ts`) -- Factory function (matching `createLogger()`, `createEventHandler()` convention) that returns `{ handler: CustomMessageHandler, sendRequest, ... }`. Implements `CustomMessageHandler.new_impl()`. Synchronously receives/sends LSPS0 messages (type 37913). Bridges sync callbacks to async consumers via a promise-keyed message queue.

2. **`LSPS2Client`** (`src/ldk/lsps2/client.ts`) -- Async state machine implementing the LSPS2 protocol. Sends `get_info` and `buy` requests, processes responses, generates JIT invoices. Pure functions `selectCheapestParams()` and `calculateOpeningFee()` are exported standalone for testability.

3. **`lsps2/types.ts`** -- TypeScript types for LSPS2 JSON-RPC messages, fee params, and client state. Also contains JSON serialization/deserialization pure functions for unit testing.

4. **Integration in `LdkContext`** -- Exposes `requestJitInvoice()` to the UI, wiring the LSPS2Client to PeerManager and ChannelManager.

5. **Updated event handler** -- Accepts inbound 0-conf channels from the configured LSP.

### Sync/Async Bridge Architecture

The fundamental tension: `CustomMessageHandler.handle_custom_message()` is synchronous (called by PeerManager during `process_events()`), but the LSPS2 protocol requires async coordination.

**Pattern: Promise-based message queue**

```
Outbound: LSPS2Client.sendRequest(method, params)
  -> serializes JSON-RPC -> pushes to outbound queue
  -> returns Promise keyed by JSON-RPC ID (crypto.randomUUID())
  -> caller triggers peerManager.process_events() to flush immediately
  -> PeerManager calls get_and_clear_pending_msg() -> drains queue

Inbound: PeerManager calls handle_custom_message(msg, sender)
  -> sync handler checks message size (<= 64KB), discards if oversized
  -> deserializes JSON-RPC response
  -> resolves/rejects the Promise matching the JSON-RPC ID
  -> if no matching pending entry, silently discards (stale/unsolicited)
  -> LSPS2Client async code resumes
```

**Critical: From institutional learnings** (`docs/solutions/integration-issues/ldk-event-handler-patterns.md`):
- Never await inside synchronous LDK callbacks
- Return immediately from `handle_custom_message()`
- Queue async work, don't block

### Research Insights: Sync/Async Bridge

**Critical -- Outbound message flush latency (Performance Oracle, Race Condition Reviewer):**
Promise resolution in `handle_custom_message()` happens synchronously. The `.then()`/`await` continuation runs as a microtask. But `peerManager.process_events()` is called synchronously *before* microtasks run. So after `get_info` response resolves and `LSPS2Client` queues the `buy` request, that message sits in the queue until the *next* `process_events()` call -- up to 10 seconds.

**Fix:** After each `LSPS2Client` method that queues an outbound message, explicitly call `peerManager.process_events()`:

```typescript
// In LdkContext.requestJitInvoice():
const params = await lsps2Client.getOpeningFeeParams(lspNodeId)
peerManager.process_events() // flush buy request immediately
const result = await lsps2Client.buyChannel(lspNodeId, selectedParams, amountMsat)
```

**Critical -- Promise lifetime management (TS Reviewer, Security):**
Pending promises MUST have:
- **30-second timeout reaper** -- Reject any promise older than 30s. Without this, a lost response means the Receive page shows "Setting up..." forever.
- **Cleanup on `peer_disconnected`** -- Iterate and reject ALL pending entries for the peer, then delete them from the Map.
- **Cap of 10 pending requests per peer** -- Prevents memory leaks from buggy retry loops.
- **Connection-scoped request IDs** -- Use `crypto.randomUUID()` (prevents prediction, scopes to session).

```typescript
// Reaper in createLspsMessageHandler:
const reaperTimer = setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > 30_000) {
      entry.reject(new Error('LSPS2 request timed out'))
      pending.delete(id)
    }
  }
}, 5_000)
// Cancel on teardown
```

**Microtask ordering safety (Race Condition Reviewer):**
The outbound queue drain in `get_and_clear_pending_msg()` cannot interleave with queue pushes in single-threaded JS. This is safe. Add a comment explaining this invariant so future changes don't break it.

### Implementation Phases

#### Phase 1: LSPS0 Transport + LSPS2 Protocol Client

Build the `CustomMessageHandler` and the LSPS2 client protocol together -- they have no standalone value apart.

**Files:**

- `src/ldk/lsps2/message-handler.ts` -- `createLspsMessageHandler()` factory returning `{ handler, sendRequest, destroy }`:
  - `handle_custom_message(msg, sender_node_id)` -- size guard (64KB), deserialize `RawLSPSMessage`, parse JSON-RPC, route to pending request resolvers. Silently discard unmatched responses.
  - `get_and_clear_pending_msg()` -- drain outbound message queue
  - `peer_disconnected(their_node_id)` -- reject ALL pending promises for peer, delete entries
  - `peer_connected(their_node_id, msg, inbound)` -- no-op
  - `provided_node_features()` / `provided_init_features(their_node_id)` -- investigate feature bit 729 API surface (see below)
  - 30-second timeout reaper with `setInterval`, cleared on `destroy()`
  - Cap of 10 pending requests per peer

- `src/ldk/lsps2/types.ts` -- Types and serialization:
  - `OpeningFeeParams` type with `min_fee_msat: bigint` (parsed from JSON string), `proportional: number` (u32, safe as JS number), `valid_until: string` (ISO 8601), etc.
  - JSON-RPC request/response envelope types
  - `serializeRequest()` / `deserializeResponse()` pure functions
  - **Must parse u64 fields (`min_fee_msat`, `min_payment_size_msat`, `max_payment_size_msat`) from JSON strings to bigint during deserialization** -- never trust `JSON.parse()` default number conversion for these
  - **Must reject `opening_fee_params` objects with unrecognized fields** (bLIP-52 spec requirement)

- `src/ldk/lsps2/client.ts` -- `LSPS2Client` class + exported pure functions:
  - `getOpeningFeeParams(lspNodeId, token?)` -- sends `lsps2.get_info`, returns `OpeningFeeParams[]`
  - `buyChannel(lspNodeId, feeParams, paymentSizeMsat)` -- sends `lsps2.buy`, returns `{ jitChannelScid, lspCltvExpiryDelta }`
  - `createJitInvoice(...)` -- creates BOLT11 with route hint (inlined, no separate file)
  - Exported pure: `selectCheapestParams(menu, paymentSizeMsat)` -- filters by payment size bounds, picks cheapest
  - Exported pure: `calculateOpeningFee(paymentSizeMsat, feeParams)` -- deterministic fee calculation

**Fee calculation** (must match spec exactly, with mandatory u64 overflow checks):
```typescript
const U64_MAX = (1n << 64n) - 1n

function calculateOpeningFee(paymentSizeMsat: bigint, params: OpeningFeeParams): bigint {
  const product = paymentSizeMsat * BigInt(params.proportional)
  if (product > U64_MAX) throw new Error('Fee calculation overflow')
  const sum = product + 999_999n
  if (sum > U64_MAX) throw new Error('Fee calculation overflow')
  const proportionalFee = sum / 1_000_000n
  return proportionalFee < params.minFeeMsat ? params.minFeeMsat : proportionalFee
}
```

**Client-side validation before `buy` (Security):**
- `paymentSizeMsat >= params.minPaymentSizeMsat`
- `paymentSizeMsat <= params.maxPaymentSizeMsat`
- `calculateOpeningFee(paymentSizeMsat, params) < paymentSizeMsat`
- `new Date(params.validUntil) > new Date(Date.now() + 120_000)` (120s buffer for clock skew + network latency)
- If `client_trusts_lsp` is true in buy response -> refuse with error: "This LSP requires a trust mode that is not supported. Your funds would not be protected until the channel is confirmed."

**Error handling:**
- `invalid_opening_fee_params` (201) -> surface to UI: "Fee parameters expired, please try again"
- `payment_size_too_small` (202) -> surface to UI: "Amount too small for Lightning channel"
- `payment_size_too_large` (203) -> surface to UI: "Amount too large for this LSP"
- `client_rejected` (1) -> surface to UI: "LSP rejected request"

**Integration:**
- `src/ldk/init.ts` line 491 -- Replace `ignorer.as_CustomMessageHandler()` with `lspsHandler.handler`
- Note: `ignorer` variable at line 473 is NOT removed -- still used for `ignorer.as_CustomOnionMessageHandler()` at line 483

**Investigation items:**
- **Feature bit 729:** Verify that `NodeFeatures`/`InitFeatures` expose `set_optional_custom_bit(729)` in WASM bindings. If not, returning empty features may be acceptable (some LSPs may not require this bit). Add to risk table.
- **Invoice route hints:** The standard `create_invoice_from_channelmanager` does not support custom route hints. Must investigate: (1) Does `UtilMethods` expose a variant with route hints? (2) Does the WASM expose `RouteHint`/`RouteHintHop` constructors? (3) Fallback: manual BOLT11 encoding. **This investigation should happen at the START of Phase 1, not after.**

**Success criteria:**
- [ ] Can send a JSON-RPC request to a connected peer via PeerManager
- [ ] Can receive and parse a JSON-RPC response
- [ ] Pending promises rejected on peer disconnect (all entries for peer)
- [ ] Pending promises rejected after 30s timeout
- [ ] Oversized messages (>64KB) discarded before parsing
- [ ] Unrecognized fields in `opening_fee_params` cause rejection
- [ ] Fee calculation matches spec with u64 overflow checks
- [ ] Payment size bounds validated before `buy`
- [ ] Can complete get_info -> buy flow with a real LSP
- [ ] Generates valid BOLT11 invoice with LSP route hint
- [ ] Unit tests for: message serialization, fee calculation, param selection, error mapping, bounds validation
- [ ] Log prefix: `[LSPS2]` for all log messages

#### Phase 2: Inbound Channel Acceptance

Accept 0-conf inbound channels from the configured LSP. This phase is **independent of Phase 1** and can be implemented in parallel.

**Files:**

- `src/ldk/traits/event-handler.ts` -- Update `Event_OpenChannelRequest` handler:
  ```typescript
  if (event instanceof Event_OpenChannelRequest) {
    const counterpartyHex = bytesToHex(event.counterparty_node_id)
    // IMPORTANT: use bytesToHex(), never .write() (see learnings: ldk-wasm-write-vs-direct-uint8array)
    if (counterpartyHex === lspNodeId) {
      // Generate user_channel_id with 8 random bytes (not 16!) to avoid u128 encoding bug
      // See learnings: ldk-wasm-encode-uint128-asymmetry
      const userChannelId = BigInt('0x' + bytesToHex(crypto.getRandomValues(new Uint8Array(8))))
      channelManager.accept_inbound_channel_from_trusted_peer_0conf(
        event.temporary_channel_id, event.counterparty_node_id, userChannelId
      )
    } else {
      const userChannelId = BigInt('0x' + bytesToHex(crypto.getRandomValues(new Uint8Array(8))))
      channelManager.accept_inbound_channel(
        event.temporary_channel_id, event.counterparty_node_id, userChannelId
      )
    }
    return
  }
  ```

- `src/ldk/traits/event-handler.ts` -- Thread LSP pubkey: add `lspNodeId: string` parameter to `createEventHandler()` function signature (consistent with how other dependencies are injected).

- `src/ldk/init.ts` -- Update `UserConfig` in **BOTH** code paths:
  - Line 389 (ChannelManager deserialization) AND line 456 (fresh creation)
  - Extract into shared function:
  ```typescript
  function createUserConfig(): UserConfig {
    const config = UserConfig.constructor_default()
    config.set_manually_accept_inbound_channels(true)
    return config
  }
  ```
  - Verify API: `set_manually_accept_inbound_channels()` may be on `UserConfig` directly or on `ChannelHandshakeConfig` in LDK 0.1.8 WASM. Check the `.d.mts` declaration.

- `src/ldk/config.ts` -- Add LSP configuration (flat keys, matching existing pattern):
  ```typescript
  lspNodeId: (import.meta.env.VITE_LSP_NODE_ID as string | undefined) ?? '<mutinynet-lsp-pubkey>',
  lspHost: (import.meta.env.VITE_LSP_HOST as string | undefined) ?? '<mutinynet-lsp-host>',
  lspPort: Number(import.meta.env.VITE_LSP_PORT ?? '<port>'),
  lspToken: import.meta.env.VITE_LSP_TOKEN as string | undefined,
  ```

- `src/ldk/init.ts` -- Validate LSP config at `initializeLdk()` time:
  - pubkey is 66 lowercase hex chars (`/^[0-9a-f]{66}$/`)
  - host matches DNS-safe charset
  - port is 1-65535
  - Fail early with clear error if invalid

**Security boundary:**
- Only 0-conf accept from the configured LSP pubkey
- All other inbound channels accepted with standard confirmation
- LSP pubkey validated via BOLT8 Noise handshake (transport-layer authentication)

**From institutional learnings** (`docs/solutions/integration-issues/bdk-ldk-signer-provider-fund-routing.md`):
- JIT channels route close funds to BDK wallet addresses via the custom SignerProvider already in place
- No additional SignerProvider changes needed

**Success criteria:**
- [ ] Inbound 0-conf channels from LSP are accepted
- [ ] Inbound channels from non-LSP peers are accepted with standard confirmations
- [ ] `manually_accept_inbound_channels` is set to `true` in both UserConfig paths
- [ ] user_channel_id generated with 8 random bytes (not 16)
- [ ] LSP pubkey comparison uses `bytesToHex()`, not `.write()`
- [ ] LSP config validated at init time
- [ ] No regression in existing channel open flows

#### Phase 3: Context Integration + Receive UI

Wire LSPS2 into the React context and update the Receive page. Combined because context changes have no value without UI.

**Files:**

- `src/ldk/ldk-context.ts` -- Add to `LdkContextValue` (when `status === 'ready'`):
  ```typescript
  requestJitInvoice: (amountMsat: bigint, description: string) => Promise<JitInvoiceResult>
  ```
  Where `JitInvoiceResult = { bolt11: string, openingFeeMsat: bigint }` defined in `ldk-context.ts` alongside `PaymentResult`.

  Note: `requestJitInvoice` is async (unlike the sync `createInvoice`). This is a justified divergence -- the LSPS2 flow requires network round-trips. `openingFeeMsat` is always present (v1 requires amount).

- `src/ldk/context.tsx` -- Add `requestJitInvoice` callback:
  1. Connect to LSP if not connected (with exponential backoff retry, max 3 attempts)
  2. Call `lsps2Client.getOpeningFeeParams()`
  3. **Call `peerManager.process_events()`** to flush buy request
  4. Select cheapest valid params for the amount
  5. Call `lsps2Client.buyChannel()`
  6. **Call `peerManager.process_events()`** to flush (defensive)
  7. Call `createJitInvoice()` with the virtual SCID
  8. Return the invoice and calculated opening fee

- `src/ldk/context.tsx` -- Pre-connect to LSP at startup:
  - Add LSP to the peer reconnection loop (lines 645-688) on first initialization
  - Eliminates 1-3s from first JIT negotiation

- `src/ldk/context.tsx` -- Add `visibilitychange` handler for tab foreground:
  ```typescript
  // In existing handleVisibilityChange:
  } else if (document.visibilityState === 'visible' && nodeRef.current) {
    drainEventsRef.current?.()
  }
  ```
  Without this, returning from a backgrounded tab after JIT channel opens shows stale "Setting up..." state.

- `src/ldk/init.ts` -- Update `LdkNode` interface and `initializeLdk()`:
  - Construct `createLspsMessageHandler()` and `LSPS2Client` BEFORE PeerManager (PeerManager takes handler at construction)
  - Pass `lspsHandler.handler` to PeerManager
  - Return `lsps2Client` and `lspsHandler` on `LdkNode`

- `src/pages/Receive.tsx` -- State machine for JIT flow:

  ```typescript
  type JitState =
    | { step: 'idle' }
    | { step: 'negotiating' }
    | { step: 'ready'; invoice: string; fee: bigint }
    | { step: 'error'; message: string; canRetry: boolean }
  ```

  - Check if any channel has inbound capacity >= requested amount
  - If no: use `requestJitInvoice()` instead of `createInvoice()`
  - Show opening fee as informational text: "Opening fee: X sats"
  - Loading state during negotiation: "Setting up Lightning receive..."
  - Error states with retry option
  - `processingRef` guard to prevent concurrent `requestJitInvoice()` calls
  - Staleness flag in `useEffect` cleanup to prevent state updates after unmount or amount change:
    ```typescript
    useEffect(() => {
      let stale = false
      // ... async flow ...
      return () => { stale = true }
    }, [amountMsat])
    ```
  - BIP 21 URI still includes on-chain fallback address
  - If LSPS2 negotiation fails, fall back to on-chain-only URI (graceful degradation from BIP321 learnings)

**Retries live in one place:** `requestJitInvoice()` retries LSP connection (max 3 with backoff). The UI shows "Retrying..." during these attempts and "Failed -- tap to retry" only after all retries exhausted. No retry logic in the UI layer.

**Success criteria:**
- [ ] `requestJitInvoice()` completes the full LSPS2 flow and returns a valid invoice
- [ ] LSP connection established automatically (pre-connected at startup)
- [ ] Errors propagate to the caller with actionable messages
- [ ] Receive page auto-detects no-liquidity and uses LSPS2
- [ ] Opening fee displayed as informational text
- [ ] Loading states during LSPS2 negotiation
- [ ] Error states for LSP failures with retry option
- [ ] BIP 21 URI still includes on-chain fallback address
- [ ] No concurrent `requestJitInvoice()` calls (processingRef guard)
- [ ] Stale async results discarded on unmount/amount change
- [ ] visibilitychange handler drains events on tab foreground
- [ ] JIT invoice returns compatible string for existing BIP 321 URI construction

## System-Wide Impact

### Interaction Graph

1. User taps "Receive" -> `Receive.tsx` checks channel inbound capacity -> calls `requestJitInvoice()` on `LdkContext`
2. `LdkContext.requestJitInvoice()` -> calls `LSPS2Client.getOpeningFeeParams()` -> pushes JSON-RPC to outbound queue
3. **`peerManager.process_events()`** called explicitly -> `LspsMessageHandler.get_and_clear_pending_msg()` -> sends over wire
4. LSP responds -> `PeerManager.read_event()` -> calls `LspsMessageHandler.handle_custom_message()` -> resolves pending Promise
5. `LSPS2Client.buyChannel()` -> same send/receive cycle (with explicit `process_events()` flush) -> returns virtual SCID
6. `createJitInvoice()` -> builds BOLT11 with route hint -> returned to UI
7. Payer pays -> LSP intercepts -> opens 0-conf channel -> `Event_OpenChannelRequest` fires -> accepted (counterparty matches LSP pubkey)
8. HTLC forwarded -> `Event_PendingHTLCsForwardable` -> `Event_PaymentClaimable` -> existing claim logic

### Error Propagation

- `LspsMessageHandler` sync errors -> logged with `[LSPS2]` prefix, Promise rejected -> `LSPS2Client` catches -> propagates to UI
- LSP disconnects -> all pending Promises rejected with `PeerDisconnected` error -> UI shows "LSP disconnected, retrying..."
- Request timeout (30s) -> Promise rejected -> UI shows error with retry
- JSON-RPC errors (200-203) -> mapped to user-friendly messages in `LSPS2Client` -> surfaced in UI
- Channel acceptance failure -> logged, channel times out -> LSP may retry
- **Retry policy:** LSP connection retries in `requestJitInvoice()` (max 3, exponential backoff). All other errors surface to UI. No auto-retry for JSON-RPC errors.

### State Lifecycle Risks

- **`lsps2.buy` response lost (browser crash):** Safe. LSP still holds the virtual SCID. If payer pays, LSP opens channel. On restart, the `OpenChannelRequest` arrives and is accepted (unconditional acceptance from LSP pubkey). The payment arrives normally.
- **No LSPS2 state persistence needed:** Channel acceptance is purely pubkey-based. Payment claiming uses existing preimage logic. No LSPS2-specific state needs to survive restarts.
- **Outbound message queue lost (crash between queue and send):** Safe. The request never reached the LSP. User retries from the Receive page.
- **LSP config change while SCID pending:** Known limitation in single-LSP design. If config changes before channel opens, old LSP's channel will be rejected. Document as known limitation.

### API Surface Parity

- `LdkContext.createInvoice()` -- existing, unchanged (used when liquidity exists)
- `LdkContext.requestJitInvoice()` -- new, used when no liquidity. Returns `Promise<JitInvoiceResult>` (async, unlike sync `createInvoice`)
- Both produce a BOLT11 string. UI treats them identically after creation.

### Integration Test Scenarios

1. **Full JIT flow:** Connect to LSP -> get_info -> buy -> create invoice -> payer pays -> channel opens -> payment claimed
2. **LSP disconnect during negotiation:** Start get_info -> LSP disconnects -> error surfaced -> reconnect -> retry succeeds
3. **Browser refresh mid-flow:** Start lsps2.buy -> refresh page -> payer pays original invoice -> channel accepted -> payment claimed
4. **Existing liquidity bypass:** User has channel with sufficient inbound -> standard invoice created, no LSPS2
5. **Tab backgrounding:** Share invoice -> background tab -> payment arrives -> foreground tab -> visibilitychange fires -> UI updates immediately
6. **Amount change during negotiation:** User changes amount while get_info in flight -> stale flag cancels old flow -> new flow starts

## Acceptance Criteria

### Functional Requirements

- [ ] New user with no channels can receive a Lightning payment via LSPS2 JIT channel
- [ ] Fixed-amount invoices work with MPP enabled
- [ ] Opening fee displayed on Receive page (exact amount)
- [ ] 0-conf channels accepted from configured LSP only
- [ ] Non-LSP inbound channels still work (with confirmations)
- [ ] LSPS2 auto-triggers when no inbound liquidity -- no manual opt-in
- [ ] Receive page shows loading state during LSPS2 negotiation
- [ ] LSP connection errors surfaced with retry option
- [ ] BIP 21 URI still includes on-chain fallback
- [ ] Graceful degradation to on-chain-only if LSPS2 fails

### Non-Functional Requirements

- [ ] LSPS2 negotiation completes in under 5 seconds (realistic with pre-connection and explicit process_events flush)
- [ ] No main thread blocking from sync/async bridge (64KB message size guard)
- [ ] Fee calculation matches bLIP-52 spec exactly (u64 overflow checks, BigInt arithmetic)
- [ ] Pending promises timeout after 30 seconds

### Quality Gates

- [ ] Unit tests for: message serialization, fee calculation, param selection, error mapping, bounds validation, overflow detection
- [ ] Integration test with real LSP on mutinynet
- [ ] No TypeScript `as` casts on LDK Result types (use instanceof narrowing per learnings)
- [ ] Test files co-located: `src/ldk/lsps2/message-handler.test.ts`, `client.test.ts`, `types.test.ts`

## Dependencies & Prerequisites

1. **LSPS2-compatible LSP on mutinynet** -- User has one in mind; need node ID and connection details before Phase 1 testing
2. **WASM invoice API investigation** -- Must investigate route-hint invoice creation at the START of Phase 1 (not after). This is the highest technical risk.
3. **No external library dependencies** -- All LSPS2 protocol logic is self-contained TypeScript

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WASM bindings don't expose route-hint invoice creation | Medium | High | Investigate FIRST in Phase 1; fallback to manual BOLT11 encoding using RouteHint/RouteHintHop if available, or raw invoice construction |
| Feature bit 729 not settable via WASM | Medium | Low | Return empty features; many LSPs don't require the bit. Test with real LSP. |
| LSP on mutinynet unavailable or buggy | Low | High | Test with LDK's reference implementation; have backup LSP |
| `manually_accept_inbound_channels` breaks existing flows | Low | Medium | Phase 2 handles both LSP and non-LSP channels explicitly |
| Fee calculation mismatch with LSP | Low | High | u64 overflow checks + unit tests against spec edge cases |
| Outbound queue not flushed (stale buy request) | High if missed | High | Explicit `process_events()` after each LSPS2 message queued |

## Future Considerations

- **Variable-amount invoices:** Deferred from v1. Add no-MPP mode with fee schedule display.
- **`valid_until` auto-refresh:** Deferred from v1. Show warning and let user tap to refresh.
- **Upstream migration:** When `LiquidityManager` is exported in LDK WASM bindings, replace TypeScript LSPS2 protocol layer. Also update `event-handler.ts` for new LSPS2 `Event` variants.
- **LSPS1 support:** Channel purchase (vs. JIT) could reuse the LSPS0 transport layer. Placing message handler in `src/ldk/lsps2/` is acceptable for now; move to `src/ldk/traits/` if LSPS1 is added.
- **Multiple LSPs:** Config could be extended to support LSP selection/fallback.
- **BOLT12 compatibility:** The LSPS2 spec is forward-compatible with blinded paths. When zinqq adds BOLT12 offer support, JIT channels should work with blinded route hints.
- **Per-LSP WebSocket proxy:** Some LSPs run their own WS proxy. Config could support an optional `lspWsProxy` URL to avoid third-party proxy dependency.

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-28-lsps2-jit-channels-brainstorm.md](docs/brainstorms/2026-03-28-lsps2-jit-channels-brainstorm.md) -- Key decisions carried forward: TypeScript bridge approach, LSP-trusts-client model, automatic JIT on receive, 0-conf acceptance, fee display without confirmation.

### Internal References

- PeerManager CustomMessageHandler slot: `src/ldk/init.ts:491`
- Event_OpenChannelRequest handler: `src/ldk/traits/event-handler.ts:402`
- Current createInvoice: `src/ldk/context.tsx:192`
- LdkContextValue type: `src/ldk/ldk-context.ts:22`
- Config pattern: `src/ldk/config.ts:3`
- Trait implementation pattern: `src/ldk/traits/logger.ts`
- WebSocket onmessage + process_events: `src/ldk/peers/peer-connection.ts:90-106`
- Visibility change handler: `src/ldk/context.tsx:710`
- drainEventsAndRefresh microtask pattern: `src/ldk/context.tsx:519-527`
- Event handler sync/async learnings: `docs/solutions/integration-issues/ldk-event-handler-patterns.md`
- Trait defensive hardening: `docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md`
- SignerProvider fund routing: `docs/solutions/integration-issues/bdk-ldk-signer-provider-fund-routing.md`
- .write() vs Uint8Array: `docs/solutions/integration-issues/ldk-wasm-write-vs-direct-uint8array.md`
- u128 BigInt overflow: `docs/solutions/integration-issues/ldk-wasm-u128-bigint-overflow.md`
- BIP321 URI + BOLT11: `docs/solutions/integration-issues/bip321-unified-uri-bolt11-invoice-generation.md`
- State machine pattern: `docs/solutions/design-patterns/react-send-flow-amount-first-state-machine.md`
- UI update delay fix: `docs/solutions/ui-bugs/channel-state-ui-update-10s-delay.md`
- WebSocket post-handshake relay: `docs/solutions/logic-errors/websocket-onmessage-blocked-after-noise-handshake.md`

### External References

- bLIP-52 spec: https://github.com/lightning/blips/blob/master/blip-0052.md
- LSPS2 spec: https://github.com/BitcoinAndLightningLayerSpecs/lsp/blob/main/LSPS2/README.md
- LSPS0 transport spec: https://github.com/BitcoinAndLightningLayerSpecs/lsp/blob/main/LSPS0/README.md
- LDK lightning-liquidity reference: https://github.com/lightningdevkit/rust-lightning/tree/main/lightning-liquidity
