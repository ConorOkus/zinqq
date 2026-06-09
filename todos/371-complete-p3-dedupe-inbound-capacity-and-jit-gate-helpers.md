---
status: complete
priority: p3
issue_id: '371'
tags: [code-review, quality, simplification, receive-flow]
dependencies: []
---

# Extract shared `usableInboundMsat` / JIT-gate helpers (Receive.tsx duplication)

## Problem Statement

PR #165 added a third (and fourth) copy of the "sum usable inbound capacity"
loop in `Receive.tsx`. It now appears in:

- `editingNeedsJit` memo (`:105-108`, new)
- the driver effect (`:153-158`)
- `handleConfirmAmount` (`:362-364`)
- plus the related `.some(is_usable)` in `needsAmount` (`:97`)

`editingNeedsJit` and `handleConfirmAmount` compute the identical predicate
(`inboundMsat < amount*1000n`), just for the editing vs committed amount — the
new code even comments "Mirrors the decision in handleConfirmAmount," an
explicit admission of duplication. Flagged by code-simplicity (P2),
kieran-typescript (P2), agent-native (P3).

## Findings

- **File**: `src/pages/Receive.tsx:97, 105-116, 359-368, 153-158`.
- Two sub-issues:
  - The `editingNeedsJit` `useMemo` buys nothing — `editingAmountSats` is a
    freshly-allocated bigint every render, so it recomputes each keystroke
    anyway (false caching).
  - The "defense in depth" guard in `handleConfirmAmount` (`:366-370`) re-derives
    the floor check that `belowJitMinimum` already expresses.

## Proposed Solutions

### Option A — Extract one helper, reuse everywhere (Small, recommended)
```ts
function usableInboundMsat(listChannels: ListChannelsFn | null): bigint {
  let inbound = 0n
  for (const ch of listChannels?.() ?? []) {
    if (ch.get_is_usable()) inbound += ch.get_inbound_capacity_msat()
  }
  return inbound
}
```
- `editingNeedsJit` → `usableInboundMsat(listChannels) < editingAmountSats * 1000n`
  (drop the `useMemo`, compute inline).
- `handleConfirmAmount` → `const needsJit = usableInboundMsat(listChannels) < amountMsat`
  and replace the recomputed floor check with `if (belowJitMinimum) return`
  (add `belowJitMinimum` to the callback deps).
- Driver effect → use the helper for the sum (keeps the loop's deps situation
  unchanged since `listChannels` is already referenced inline there).

Net ~8-12 lines removed and the "Mirrors the decision in…" coupling disappears.

## Recommended Action

(Triage) Option A. Do NOT unify `reQuoteSkippingPrimary` with the driver effect —
two reviewers confirmed the divergence (different `quoteStatus`, error handling,
cleanup) makes a shared runner larger than the duplication it would remove.

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`.

## Acceptance Criteria

- [ ] Single inbound-capacity helper used by all JIT sites.
- [ ] `handleConfirmAmount` floor check reuses `belowJitMinimum`.
- [ ] No behavior change; Receive tests still green.

## Work Log

- 2026-06-09 — Filed from `/ce:review` of PR #165.
- 2026-06-09 — **Resolved.** Extracted module-level `usableInboundMsat(channels)`
  in `Receive.tsx`; reused in `editingNeedsJit` (dropped the false-caching
  `useMemo`), the driver effect's sum, and `handleConfirmAmount`.
  `handleConfirmAmount` now reuses the `belowJitMinimum`/`editingNeedsJit` derived
  values instead of re-deriving the floor check + capacity loop. The
  "Mirrors the decision in handleConfirmAmount" coupling is gone. Did NOT unify
  `reQuoteSkippingPrimary` with the driver effect (two reviewers confirmed the
  divergence makes a shared runner larger than the duplication). No behavior
  change; tests green.

## Resources

- PR #165
- Related cleanup: `todos/310-pending-p2-dead-state-fields-receive-state.md`
  (PR #165 adds a `quoteStatus: 'updated'` write; consider together).
