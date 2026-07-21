---
status: complete
priority: p1
issue_id: '398'
tags: [code-review, fund-safety, event-handler, sweep, pr-172]
dependencies: []
---

# Unguarded WASM reads in the SpendableOutputs persist path can silently drop sweepable outputs

## Problem Statement

The new `SpendableOutputsEntry` construction (`src/ldk/traits/event-handler.ts:429-440`)
calls `o.spendable_outpoint()`, `get_txid()`, `get_index()` synchronously with no
per-output guard. If any throws (binding edge case), the exception propagates to
`handle_event`'s top-level catch, which logs and still returns ok() — LDK considers the
event consumed, the descriptors are NEVER persisted, and the outputs are never swept.
Permanent loss of sweepable funds on a mainnet wallet. Before this PR only `o.write()` ran
in that critical section; the PR tripled the throw surface between event delivery and
persistence.

## Findings

- security-sentinel, MEDIUM-HIGH: likelihood low (accessors exist on all three variants in
  LDK 0.2) but impact is permanent fund loss.
- `readDescriptorValueSats` is already internally try/caught; the outpoint extraction is not.
- The descriptors write is the fund-safety payload; attribution (channelId/outpoints) is
  cosmetic and can degrade.

## Proposed Solutions

### Option A: Per-output try/catch, degrade attribution

Wrap outpoint extraction per output; on failure use `outpoints: []` (and keep
`channelIdHex` best-effort). Descriptors always persist. Effort: Small. Risk: none.

### Option B: Build descriptors-first, attribution second

Persist `{ descriptors }` immediately, then attempt attribution enrichment in a separate
guarded step. Effort: Small-Medium. Risk: two writes.

## Recommended Action

Fixed: Option A — per-output try/catch; descriptors always persist, attribution degrades to empty.

## Technical Details

- **Affected files**: `src/ldk/traits/event-handler.ts` (Event_SpendableOutputs block).

## Acceptance Criteria

- [x] A throwing `spendable_outpoint()` on one descriptor still persists ALL descriptors
      (unit test with a poisoned mock output)
- [x] Attribution degrades to empty, never blocks the IDB write

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (security-sentinel #1).
- 2026-07-21: Fixed on feat/close-records-engine; tests added (580 total passing).
