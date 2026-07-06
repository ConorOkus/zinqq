---
status: complete
priority: p1
issue_id: 374
tags: [code-review, ldk, correctness, latency, receive-flow]
dependencies: []
---

# HTLC forward processing only runs on the 10s timer (and before event draining) — receive/JIT stalls up to ~10s

## Problem Statement

The LDK 0.2 migration replaced `Event::PendingHTLCsForwardable` with a poll of
`channelManager.needs_pending_htlc_processing()` → `process_pending_htlc_forwards()`.
That poll was added **only** to the ~10s `peerTimerId` loop, and in a spot that runs
**before** events are drained in the same tick. The WebSocket-message and tab-foreground
event-drain paths (`drainEventsRef` → `drainEventsAndRefresh()`) do **not** trigger HTLC
processing at all.

Result: an inbound HTLC (including the finalization of a received/JIT payment into a
`PaymentClaimable`) can idle up to a full `peerTimerIntervalMs` (~10s) before being
processed — even when a WebSocket commitment message just delivered it. The old model was
event-driven and fired within `time_forwardable` (typically sub-second). This is a
user-visible regression in the wallet's **primary receive flow**.

Not a fund-loss bug — LDK holds HTLCs until processed — but it degrades receive UX and, at
the margin (tight peer CLTV windows), raises exposure to timeout-driven force-closes.

Flagged independently by the architecture reviewer (P1) and the security reviewer (P2 §4.1).

## Findings

- `src/ldk/context.tsx:1243-1244` — HTLC poll is inside the 10s `setInterval` only.
- `src/ldk/context.tsx:1259` — `drainEventsAndRefresh()` is called in the same tick **after**
  the poll at 1243, so HTLCs made forwardable by this tick's event draining wait until the
  next tick.
- `src/ldk/context.tsx:1135-1138` — `drainEventsAndRefresh()` calls `process_pending_events`
  on the three EventsProviders but never `needs_pending_htlc_processing`/`process_pending_htlc_forwards`.
- `src/ldk/context.tsx:1187-1194` (`drainEventsRef`, wired to WebSocket/LSPS message handlers)
  and `:1470` (tab-foreground handler) both call `drainEventsAndRefresh()` and therefore
  never forward HTLCs.
- No HTLC processing on the initial synchronous init path either — the first forward waits
  for the first timer tick.

## Proposed Solutions

### Option A (recommended) — move the check into `drainEventsAndRefresh()`, after event draining

Add, at the end of `drainEventsAndRefresh()`:

```ts
if (node.channelManager.needs_pending_htlc_processing()) {
  node.channelManager.process_pending_htlc_forwards()
}
```

and remove the standalone block at `context.tsx:1243-1244` (the timer already calls
`drainEventsAndRefresh()` at 1259). This makes every drain path — timer, WebSocket message,
tab-foreground — cover HTLC forwarding, and runs it **after** `process_pending_events` so
HTLCs made forwardable this tick are handled immediately.

- Pros: single choke point; fixes coverage + ordering + init path in one place; minimal LOC.
- Cons: `process_pending_htlc_forwards` now runs on every drain (cheap when the `needs_*`
  guard returns false).
- Effort: Small. Risk: Low.

### Option B — loop-until-drained inside the tick + add to foreground handler

Keep the timer block but wrap it in a `while (needs_pending_htlc_processing())` and also add
the check to the foreground handler. More code, more places to keep in sync.

- Effort: Small/Medium. Risk: Low/Medium (two call sites to maintain).

## Recommended Action

_(leave blank for triage)_

## Technical Details

- Affected file: `src/ldk/context.tsx` (`drainEventsAndRefresh`, `drainEventsRef`, peer timer loop, foreground handler).
- No schema/data changes.

## Acceptance Criteria

- [ ] HTLC forwarding is triggered on the WebSocket-message drain path and the tab-foreground path, not just the 10s timer.
- [ ] The `needs_pending_htlc_processing()` check runs **after** `process_pending_events` within a drain.
- [ ] Standalone duplicate check removed (no double-processing per tick).
- [ ] Verified on regtest: a JIT/receive payment produces `PaymentClaimable` promptly (sub-second under load), not after ~10s.
- [ ] `pnpm typecheck` + tests + build green.

## Work Log

- 2026-07-06 — Filed from `/ce:review` of PR #166. Confirmed call-site ordering in context.tsx; both architecture and security reviewers independently flagged it.
- 2026-07-06 — FIXED (Option A). Moved the `needs_pending_htlc_processing()`/`process_pending_htlc_forwards()` check into `drainEventsAndRefresh()` (after `process_pending_events`) and removed the standalone timer block. All three drain paths (timer, WebSocket message, tab-foreground) now cover HTLC forwarding. typecheck + 472 tests + build green. Regtest confirmation folded into the PR's runtime-validation gate.

## Resources

- PR #166 — LDK 0.1 → 0.2 upgrade.
- `docs/solutions/integration-issues/ldk-event-handler-patterns.md` (old PendingHTLCsForwardable pattern).
- `docs/plans/2026-07-06-001-chore-upgrade-lightningdevkit-0-2-plan.md` (mapped break #1).
