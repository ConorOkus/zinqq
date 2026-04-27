---
status: pending
priority: p2
issue_id: '259'
tags: [code-review, payjoin, privacy, plan-deferral]
dependencies: []
---

# Single-UTXO Payjoin pre-flight skip is missing

## Problem Statement

The plan (`docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md` lines 222, 408) requires `tryPayjoinSend` to skip Payjoin when the original PSBT has only one input. The implementation only skips on `sendMax` (Send.tsx-side) and on the kill switch.

Payjoin with a single sender input is a privacy anti-pattern: the merge proof becomes degenerate and chain analysis can identify the sender's contributing input by elimination.

## Findings

- **architecture-strategist #9**: explicit plan requirement, not implemented.
- The plan called this out specifically because Payjoin's privacy benefit comes from breaking the common-input-ownership heuristic. With one sender input, that heuristic still trivially identifies the sender's contribution.

## Proposed Solutions

### Option 1 (recommended) — Pre-flight skip in `tryPayjoinSend`

Before `loadPdk()`:

```ts
if (unsigned.unsigned_tx.input.length < 2) {
  return unsigned // or { kind: 'declined' } if todo #255 lands first
}
```

Cheap, no telemetry per plan ("declined pre-flight, no telemetry").

- Pros: matches plan; preserves privacy semantics.
- Cons: any wallet with consolidated funds (single UTXO) loses Payjoin until they have ≥2 UTXOs again.

### Option 2 — Document the deferral

Update the plan with a "shipped without single-UTXO skip — accepting the privacy regression" note.

- Pros: zero code change.
- Cons: violates the plan's explicit privacy intent for a self-custodial wallet.

## Recommended Action

Option 1. One-line change.

## Technical Details

- Affected file: `src/onchain/payjoin/payjoin.ts` — add early return in `tryPayjoinSend` after kill-switch check
- Test: add a unit test "skips Payjoin when original PSBT has only one input"
- Coordinate with todo #255 (discriminated union) — this should return `{ kind: 'declined' }` if that lands first.

## Acceptance Criteria

- [ ] Pre-flight skip on `inputs.length < 2`
- [ ] Test exercises the skip
- [ ] No telemetry emitted on the skip path

## Work Log

## Resources

- PR #143
- Plan: `docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md` lines 222, 408
