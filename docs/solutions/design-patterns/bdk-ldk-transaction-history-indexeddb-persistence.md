---
title: Real Transaction History from BDK and LDK with IndexedDB Persistence
category: design-patterns
severity: HIGH
date: 2026-03-16
modules: [Activity, OnchainContext, LdkEventHandler, useTransactionHistory, ldk_payment_history]
tags: [bdk, ldk, indexeddb, payment-persistence, transaction-history, react-context, wasm]
---

# Real Transaction History from BDK and LDK with IndexedDB Persistence

The Activity screen displayed hardcoded mock transactions and needed to show real on-chain (BDK) and Lightning (LDK) payment data, but LDK's `listRecentPayments()` is volatile and provides no timestamps, requiring a custom IndexedDB persistence layer (`ldk_payment_history`) written to on `PaymentClaimed` events and at send time. The primary integration issue (P1) was that inbound Lightning payments were persisted to IDB but never triggered a React context update, so they were invisible in the UI until a manual refresh.

## Root Cause

LDK's `listRecentPayments()` is volatile -- payment data is lost on page refresh -- and provides no timestamps. `PaymentClaimed` events for inbound Lightning payments were only logged to the console, never persisted. On the on-chain side, BDK's `wallet.transactions()` and `sent_and_received()` were not exposed through the `OnchainContext`, so there was no way to display real transaction history.

## Solution

**IDB schema migration (v6 to v7):** Added a new `ldk_payment_history` object store with a `SerializedPayment` type that converts `bigint` fields to strings for IndexedDB compatibility.

**Persistence layer (`payment-history.ts`):**

- `persistPayment()` -- writes a new payment record to IDB
- `updatePaymentStatus()` -- updates an existing record's status using `idbGet()` for O(1) lookup
- `loadAllPayments()` -- reads all records, deserializing string amounts back to bigint

**Event-driven persistence:**

- Outbound payments are persisted by LDK context at send time (`sendBolt11Payment`, `sendBolt12Payment`, `sendBip353Payment`)
- Inbound payments are persisted when the `PaymentClaimed` event fires in the event handler
- `PaymentSent` and `PaymentFailed` events update existing outbound records

**On-chain transactions:** `OnchainContext` gains a `listTransactions()` method that reads `wallet.transactions()` and calls `sent_and_received()` on each to determine direction and net amount.

**Unified view:** `useTransactionHistory()` hook merges Lightning payments from IDB and on-chain transactions from BDK into a single `UnifiedTransaction[]` array, sorted by timestamp descending.

**Update — three-way merge with channel-close records.** `useTransactionHistory()` (`src/hooks/use-transaction-history.ts`, ~11-56) now also imports `useCloseRecords`/`useLastKnownTipHeight` and adds a third `UnifiedTransaction` variant, `layer: 'channel-close'`, carrying `amountSats: bigint | null`, `channelId`, and `closeStatus`. Each close record renders as one grouped row rather than as its raw constituent transactions. To prevent double-listing, the hook builds an `absorbedTxids` set from every txid referenced inside a close record and skips those txids when iterating on-chain transactions — so a channel's commitment/sweep/closing txs appear once, inside the close row, never again as bare on-chain receives.

## Key Code Patterns

**Bigint-safe IDB serialization:** IDB cannot store `bigint` values. The `SerializedPayment` type maps amount fields to `string`, with `persistPayment()` converting via `.toString()` and `loadAllPayments()` converting back via `BigInt()`.

**Event callback extension:** The `PaymentEventCallback` type was extended to include a `'claimed'` variant so that the event handler can notify the LDK context to call `refreshPaymentHistory()` on inbound payment arrival, not just on sent/failed.

**Merged transaction sorting:** `useTransactionHistory()` assigns a common shape (`UnifiedTransaction`) to both sources, using LDK's persisted timestamp and BDK's `confirmation_time` (falling back to `first_seen`, then `0` for unconfirmed), then sorts the combined array.

**Granular useMemo deps:** Extract specific values (`listTransactions`, `paymentHistory`, `balance`) from context objects before passing to `useMemo`, so the memo only recomputes when transaction data actually changes -- not on unrelated sync status or channel counter updates.

## Gotchas Encountered

1. **PaymentClaimed never refreshed UI.** The `onPaymentEvent` callback only fired for `sent` and `failed` types. Inbound payments were persisted to IDB by the event handler but the React state was stale until the next full page load. Fix: add `'claimed'` to the callback discriminated union.

2. **O(n) status updates.** `updatePaymentStatus()` originally called `loadAllPayments()` (a full cursor scan of the store) just to find and update one record. Replaced with a direct `idbGet()` by payment hash.

3. **Vercel `tsc -b` build failures.** Vercel's build runs `tsc -b` which type-checks test files. Test mock factories for `LdkContext` and `OnchainContext` were missing the newly required `listTransactions` and `paymentHistory` fields.

4. **Bigint in IndexedDB.** Attempting to store a `bigint` value directly in IDB throws a `DataCloneError` at runtime with no compile-time warning. Every amount field must be explicitly converted to `string` before persistence.

5. **formatRelativeTime(0) gibberish.** Using `0` as a fallback timestamp for transactions with no `confirmationTime` or `firstSeen` produces nonsensical display like "2930w ago". Guard against sentinel values before passing to formatters.

6. **`amountSats` can be `null` on channel-close rows.** Unlike the `onchain`/`lightning` variants, the `channel-close` variant's `amountSats` is `bigint | null` — it's `null` while the close outcome is still unresolved. Any formatter/UI boundary that renders `UnifiedTransaction.amountSats` must handle `null` by rendering a dash (`—`), never coercing it to `0` — a literal "0 sats" reads as a real (and wrong) zero-value transaction rather than "amount not yet known".

## Prevention Strategies

### IDB Write Without Context Notification

Never call `idbPut` in isolation. Every persistence operation should atomically write to IDB _and_ dispatch the corresponding context/state update. In code review, any `idbPut` call without a paired state setter in the same function body is a red flag.

### Full Table Scan Where O(1) Lookup Exists

Treat `loadAll*()` functions as initialization-only helpers. Any `loadAll*()` inside an event handler or update callback (as opposed to a top-level `useEffect` on mount) should be replaced with a targeted `idbGet(key)` call.

### useMemo Over-Subscribing to Context Objects

Destructure only the specific fields you need _before_ the `useMemo` call, and list those values in the dependency array. `useMemo` and `useCallback` dependency arrays should never contain an object that is reconstructed on every render.

### Test Mock Factories Missing New Required Fields

Define mock factories with explicit return types that reference the production type: `function createMockPayment(): Payment { ... }`. This way, adding a required field to `Payment` immediately causes a compile error in the factory. Never use `as Payment` casts in mocks.

### Formatter Boundary Inputs

Add unit tests for every formatter covering boundary values: `0`, `NaN`, `undefined`, `Date.now()` (zero delta), and future timestamps. Check for sentinel values before passing to formatters.

## Related Documentation

- [ldk-event-handler-patterns.md](../integration-issues/ldk-event-handler-patterns.md) -- LDK EventHandler sync/async bridging, fund-safety event categorization
- [bdk-wasm-onchain-wallet-integration-patterns.md](../integration-issues/bdk-wasm-onchain-wallet-integration-patterns.md) -- React context infinite re-render issue, IndexedDB shared storage
- [bdk-wasm-onchain-send-patterns.md](../integration-issues/bdk-wasm-onchain-send-patterns.md) -- BDK build/sign/broadcast pipeline, changeset persistence
- [bdk-address-reveal-not-persisted.md](../logic-errors/bdk-address-reveal-not-persisted.md) -- BDK changeset persistence bug, invisible funds after restart
- [ldk-wasm-foundation-layer-patterns.md](../integration-issues/ldk-wasm-foundation-layer-patterns.md) -- IndexedDB persistence with LDK Persist trait, React Fast Refresh context issues
- [bdk-ldk-cross-wasm-transaction-bridge.md](../integration-issues/bdk-ldk-cross-wasm-transaction-bridge.md) -- BDK transaction serialization for LDK events
- [react-send-flow-amount-first-state-machine.md](../design-patterns/react-send-flow-amount-first-state-machine.md) -- React state machine pattern for payment flows
