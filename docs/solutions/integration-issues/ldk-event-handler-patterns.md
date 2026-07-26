---
title: 'LDK EventHandler — Sync/Async Bridging and Fund-Safety Patterns'
category: integration-issues
date: 2026-03-12
last_refreshed: 2026-07-25
tags: [ldk, event-handler, lightning, typescript, fund-safety, indexeddb, wasm]
modules: [src/ldk/traits/event-handler, src/ldk/context, src/ldk/init]
---

# LDK EventHandler — Sync/Async Bridging and Fund-Safety Patterns

## Problem

LDK's `EventHandler.handle_event()` is synchronous (returns `Result_NoneReplayEventZ`), but many event responses require async operations (IDB writes, network calls). Returning `ok()` tells LDK the event is consumed forever — if the async work fails or the browser crashes, that event is lost. For fund-safety events like `SpendableOutputs` and `PaymentClaimable`, this means potential fund loss.

## Root Cause

The WASM-to-JS bridge enforces synchronous trait methods. IndexedDB and network APIs are inherently async. There is no way to "await" inside `handle_event`.

## Solution

Categorize events by their async requirements and handle each appropriately:

### Sync-safe events (call LDK methods inline)

```typescript
// PaymentClaimable — claim_funds() is a sync WASM call
if (event instanceof Event_PaymentClaimable) {
  const preimage = event.purpose.preimage()
  if (preimage instanceof Option_ThirtyTwoBytesZ_Some) {
    channelManager.claim_funds(preimage.some)
  }
  return Result_NoneReplayEventZ.constructor_ok()
}

// PendingHTLCsForwardable — schedule with delay, track timer for cleanup
if (event instanceof Event_PendingHTLCsForwardable) {
  const delayMs = Math.min(Number(event.time_forwardable) * 1000, 10_000)
  if (forwardTimerId !== null) clearTimeout(forwardTimerId) // deduplicate
  forwardTimerId = setTimeout(() => {
    channelManager.process_pending_htlc_forwards()
  }, delayMs)
  return Result_NoneReplayEventZ.constructor_ok()
}
```

> **Removed in LDK 0.2.** `Event::PendingHTLCsForwardable` no longer exists.
> Forwarding is now driven by polling `channelManager.needs_pending_htlc_processing()`
> and, when true, calling `channelManager.process_pending_htlc_forwards()` inside
> `drainEventsAndRefresh()` in `src/ldk/context.tsx` (~1328-1345). The event-handler
> side of the old pattern (the timer + `cleanup()`) is retained as a no-op for
> caller API stability (`src/ldk/traits/event-handler.ts` ~217-220 comment).

### Async events (fire-and-forget with IDB persistence)

```typescript
// SpendableOutputs — persist descriptors to IDB for future sweep
// Note: IDB write is async but handle_event is sync. If the browser
// crashes before the write commits, descriptors may be lost. Risk
// window is small (IDB writes ~<10ms) but not zero.
if (event instanceof Event_SpendableOutputs) {
  const key = crypto.randomUUID()
  const serialized = event.outputs.map((o) => o.write())
  void idbPut('ldk_spendable_outputs', key, serialized).catch(...)
  return Result_NoneReplayEventZ.constructor_ok()
}
```

> **2026-07-21 update.** `SpendableOutputs` handling has since grown well
> beyond the persist-and-forget sketch above: per-output outpoint/value
> attribution is extracted with a guarded per-output try/catch (a single
> malformed descriptor no longer drops the whole batch), an immediate sweep
> attempt is made with a fee-subsidized fallback (`src/ldk/sweep.ts`,
> `src/ldk/subsidized-sweep.ts`), and an unconditional startup-recovery sweep
> runs on handler creation to catch descriptors persisted from a prior session
> that never got swept. Since PR #177, wallet-owned `StaticOutput` descriptors
> (which already pay the BDK wallet and which KeysManager cannot sign) are
> filtered out at persist time via `isWalletOwnedStaticOutput`
> (`src/ldk/traits/event-handler.ts` ~462-468). See
> [`ldk-spendable-output-sweep-stuck-retry-and-fee-semantics.md`](ldk-spendable-output-sweep-stuck-retry-and-fee-semantics.md)
> for the sweep/retry design.

### Deferred events (historical — none remain)

```typescript
// FundingGenerationReady, BumpTransaction — need wallet/UTXO layer
if (event instanceof Event_FundingGenerationReady) {
  console.warn('[LDK Event] FundingGenerationReady: no wallet layer')
  return Result_NoneReplayEventZ.constructor_ok()
}
```

> **Superseded — both events are now fully implemented.**
> `FundingGenerationReady` builds the funding tx with the BDK wallet inside an
> async IIFE that persists to IDB _before_ calling
> `funding_transaction_generated()` (`src/ldk/traits/event-handler.ts`
> ~569-649) — a third bridging pattern: return `ok()` immediately, order the
> async work internally. `BumpTransaction` performs anchor-CPFP via
> `BumpTransactionEventHandlerSync` (since PR #128), records the commitment
> txid/fee to the channel's Close Record, and gates its "no UTXOs — deposit
> needed" recovery signal on `isInitialScanComplete()`
> (`src/onchain/scan-state.ts`; PR #179) because LDK replays bump events on
> restore before the initial scan (`src/ldk/traits/event-handler.ts`
> ~659-768). See
> [`force-close-recovery-false-positive-on-vss-restore.md`](../logic-errors/force-close-recovery-false-positive-on-vss-restore.md).
> No event is deferred pending a wallet layer anymore; the only unhandled
> path is the catch-all logger at the bottom of `handleEvent`.

### Background loop integration

> **Updated shape.** The snippet above is superseded by a single shared
> `drainEventsAndRefresh()` defined once in `src/ldk/context.tsx`, called from
> three places instead of only a timer: the periodic timer tick, the
> per-message WebSocket callback (so channel-state changes like `channel_ready`
> reflect immediately), and tab-foreground. It drains `ChannelManager`,
> `ChainMonitor`, and `OnionMessenger` events, then polls
> `needs_pending_htlc_processing()` (see the `PendingHTLCsForwardable` note
> above), then schedules a persist. The CM dirty-flag flush moved out of this
> loop and into `src/ldk/storage/persist-cm.ts`, which still uses
> `get_and_clear_needs_persistence()` as the underlying mechanism (gotcha #2
> below still applies).

```typescript
// src/ldk/context.tsx — shared drain, called from timer / WS message / tab-foreground
function drainEventsAndRefresh() {
  node.channelManager.as_EventsProvider().process_pending_events(node.eventHandler)
  node.chainMonitor.as_EventsProvider().process_pending_events(node.eventHandler)
  node.onionMessenger.as_EventsProvider().process_pending_events(node.eventHandler)

  // LDK 0.2 removed Event::PendingHTLCsForwardable; drive forwarding by polling.
  if (node.channelManager.needs_pending_htlc_processing()) {
    node.channelManager.process_pending_htlc_forwards()
  }

  // Scheduler (src/ldk/storage/persist-cm.ts) consults
  // get_and_clear_needs_persistence() and skips when clean.
  void schedulePersist()
}
```

## Key Gotchas

1. **Always wrap `handleEvent` in try/catch** — an uncaught error in one event handler aborts the entire `process_pending_events` batch, losing remaining events.

2. **`get_and_clear_needs_persistence()` clears the flag regardless of IDB write success** — if the write fails, the dirty state is never retried. Accept this risk or maintain a local dirty flag.

3. **(Historical — event removed in LDK 0.2, see the note under "Sync-safe events".)** `PendingHTLCsForwardable` timers must be tracked and deduped — multiple events in one drain cycle create orphaned timers. Clear previous timer before scheduling new one. Expose `cleanup()` for React unmount.

4. **Don't plumb dependencies you can't use yet** — `ConnectionNeeded` provides `SocketAddress` objects but the WASM bindings don't easily expose subclass types for parsing. Log and defer rather than passing empty host/port that always fails (YAGNI).

   > **Update:** `parseFirstSocketAddress()` is now implemented (`src/ldk/traits/event-handler.ts` ~863-885), handling `TcpIpV4`, `TcpIpV6`, and `Hostname` variants, and is wired up to the `onConnectionNeeded` callback. The YAGNI deferral no longer applies.

5. **`OpenChannelRequest` without explicit accept/reject will timeout** — LDK does not auto-reject. If you log "auto-rejecting" make sure you actually call the reject API, or be honest that it times out.

   > **Still true**, but acceptance is now gated by `isTrustedLsp()` (see [`ldk-event-handler-multi-lsp-trust-set.md`](ldk-event-handler-multi-lsp-trust-set.md)) plus JIT channel config overrides applied to the 0-conf accept call (see [`lsps2-jit-receive-channel-config.md`](lsps2-jit-receive-channel-config.md)) — untrusted peers still silently timeout with no explicit reject.

6. **Use `crypto.randomUUID()` for IDB keys** — `Math.random()` is not cryptographically secure and can collide under batch processing. `crypto.randomUUID()` is available in all modern browsers.

7. **Flush ChannelManager to IDB immediately after event processing** — don't wait for the 30s sync tick. A `claim_funds()` call modifies CM state; if the browser closes before persistence, the claim is lost on restart.

## Prevention

- Test every event handler branch (including error/no-preimage paths)
- Use `afterEach(() => cleanup())` in tests to clear pending timers
- Document sync/async bridge limitations in code comments for fund-safety paths
- When an event is intentionally unhandled, log it distinctly (the catch-all logs the event class name via `console.log` at the bottom of `handleEvent`) so silently-dropped events are visible in field logs
- Treat every delivered event as possibly replayed — LDK re-delivers unresolved events on every restart; handlers must be idempotent and must not infer "this is happening now" from delivery

## Related

- `docs/solutions/logic-errors/force-close-recovery-false-positive-on-vss-restore.md` — the replayed-BumpTransaction-vs-initial-scan race and the recovery exit reconcile (PR #179)
- `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` — Persist trait InProgress pattern
- `docs/solutions/infrastructure/websocket-tcp-proxy-cloudflare-workers.md` — WritableStream writer pattern
- `docs/plans/2026-03-12-003-feat-ldk-event-handling-background-tasks-plan.md`
- [LDK Event handling docs](https://lightningdevkit.org/introduction/handling-events/)
