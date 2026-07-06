---
status: complete
priority: p3
issue_id: 377
tags: [code-review, ldk, documentation, persist]
dependencies: []
---

# Document the push-only completion + persistence_key≡MonitorName invariants; annotate nullable update param

## Problem Statement

The 0.2 migration introduced two load-bearing invariants enforced only by inline comments and
test mocks:

1. **Push-only completion:** we always signal via `ChainMonitor.channel_monitor_updated` and
   deliberately return `[]` from `Persist.get_and_clear_completed_updates()`. A future maintainer
   could "helpfully" start populating the pull vec and cause double-signaling.
2. **`monitor.persistence_key().to_str()` must equal the `MonitorName.to_str()`** passed to the
   persist callbacks, or `nameToKey` lookups (and archive deletes) silently miss. Today this is
   guaranteed only by the test mock constructing them identically — a real-binding divergence
   wouldn't be caught.

Separately, `update_persisted_channel` annotates `_monitor_update: ChannelMonitorUpdate`
(non-null), but LDK 0.2 can pass `null` here during chain-sync (`Persist.d.mts:181-182,212`).
It compiles (the generated `PersistInterface` also omits `| null`) and is harmless today (the
param is unused), but the annotation misrepresents runtime reality.

## Findings

- `src/ldk/traits/persist.ts` — `get_and_clear_completed_updates(): []` (push-only invariant).
- `src/ldk/traits/persist.ts` — `registerLoadedMonitor` uses `persistence_key().to_str()`; callbacks use `monitor_name.to_str()`.
- `src/ldk/traits/persist.ts` — `update_persisted_channel(_monitor_update: ChannelMonitorUpdate, …)` should be `| null`.
- `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md` — describes only the push model; no note of the 0.2 pull alternative.

## Proposed Solutions

- Add an addendum to `ldk-wasm-foundation-layer-patterns.md`: 0.2 offers a pull completion path (`get_and_clear_completed_updates`); we deliberately decline it (push via `channel_monitor_updated`, pull returns `[]`).
- Add a code comment/assertion that `persistence_key().to_str()` and the callback `MonitorName.to_str()` must agree.
- Annotate `_monitor_update` as `ChannelMonitorUpdate | null`.
- Effort: Small. Risk: None (docs + annotation).

## Recommended Action

_(leave blank for triage)_

## Acceptance Criteria

- [ ] Solution doc updated with the push-only decision.
- [ ] Invariant note/assertion added near the nameToKey usage.
- [ ] `_monitor_update` typed `| null`.

## Work Log

- 2026-07-06 — Filed from `/ce:review` of PR #166 (architecture §P2 + TypeScript §P3).

## Resources

- PR #166. `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md`.
- 2026-07-06 — DONE. Annotated `_monitor_update: ChannelMonitorUpdate | null`; added the persistence_key≡MonitorName invariant comment in `extractMonitor`; added a "push-only completion (decline pull)" section + WASM-borrow note to `ldk-wasm-foundation-layer-patterns.md`.
