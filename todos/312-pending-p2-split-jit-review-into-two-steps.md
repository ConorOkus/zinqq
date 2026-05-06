---
status: pending
priority: p2
issue_id: '312'
tags: [code-review, simplicity, types, pr-150]
dependencies: []
---

# Split `'jit-review'` two-`kind` union into separate steps

## Problem Statement

`'jit-review'` carries two variants discriminated by `kind: 'commit' | 'below-minimum'`. The render branch in `Receive.tsx` ends up as a giant ternary inside the state-machine ternary, and the `'below-minimum'` variant carries `menu` and `lspContact` fields that are only used to compute `displayMinSats` once during the transition (after which they're never read).

The two variants represent genuinely different states (one can commit, one cannot) — they should be separate top-level steps for cleaner narrowing and a flatter render branch.

## Findings

- **File**: `src/pages/Receive.tsx:34-49` (state type)
- **File**: `src/pages/Receive.tsx:600-697` (render branch)
- **Identified by**: code-simplicity-reviewer (#4), kieran-typescript-reviewer (#2)
- Drop unused state fields: `menu`, `lspContact` (only needed transiently)

## Proposed Solutions

### Option A: Split into `'jit-review'` and `'jit-too-small'` (Recommended)

```ts
type ReceiveState =
  | ...
  | { step: 'jit-review'; amountSats: bigint; quote: JitQuote }
  | { step: 'jit-too-small'; amountSats: bigint; displayMinSats: bigint }
  | ...
```

- Compute `displayMinSats` from the menu at transition time, then drop `menu`/`lspContact`
- Render branch flattens — no inner ternary, no `kind` narrowing
- The `aria-describedby="receive-min-hint"` wiring stays simple because the disabled CTA only renders in `'jit-too-small'`
- **Pros**: Cleaner narrowing; ~15 LOC of render simplification; less state to carry
- **Cons**: Two render branches instead of one shared shell — some duplication
- **Effort**: Small
- **Risk**: Low

### Option B: Keep the `kind` discriminator + add a narrowing helper

```ts
function isCommitReview(s: ReceiveState): s is Extract<..., { kind: 'commit' }> { ... }
```

- **Pros**: Less change
- **Cons**: Still need to carry `menu` + `lspContact`; narrowing helper is a workaround for a structural problem
- **Effort**: Small

## Recommended Action

(Filled during triage)

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`, `src/pages/Receive.test.tsx` (test selectors)

## Acceptance Criteria

- [ ] `'jit-review'` and `'jit-too-small'` are sibling state-machine steps
- [ ] `menu` and `lspContact` removed from `ReceiveState`
- [ ] Render branch is flatter (no inner `kind` ternary)
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
