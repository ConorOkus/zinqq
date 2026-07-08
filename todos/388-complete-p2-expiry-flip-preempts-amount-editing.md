---
status: complete
priority: p2
issue_id: '388'
tags: [code-review, ui, receive, state-machine, pr-168]
dependencies: []
---

# Expiry flip yanks the numpad out from under a user who is mid-edit

## Problem Statement

The `jit-expired` timer transition doesn't consider `editingAmount`, and the render chain
places the `jit-expired` branch above the `editingAmount` branch — so a user editing a new
amount while the old JIT QR's expiry passes gets their numpad replaced by the
"Payment request expired" screen mid-typing. The user has already abandoned that invoice by
editing; interrupting them is wrong.

## Findings

- Timer guard (`src/pages/Receive.tsx:275-277`) checks
  `prev.step === 'ready' && prev.invoicePath === 'jit'` but not `editingAmount` (which lives
  in separate state and stays compatible with `ready`/`jit`).
- Render order (`src/pages/Receive.tsx:749` vs `:824`): `jit-expired` renders before
  `editingAmount`, so the flip wins visually.
- Repro: JIT QR displayed → "Edit amount" → expiry passes mid-typing → numpad replaced.

## Proposed Solutions

### Option A (recommended): Move the `editingAmount` render branch above `jit-expired`

State still flips underneath (correct — the invoice IS expired); the user keeps the numpad,
and on Cancel they land on the expired screen instead of a dead QR. No new deps or refs.
Effort: Trivial. Risk: low — verify Cancel/Done paths land sensibly.

### Option B: Gate the timer transition on `editingAmount` via a ref

Keeps render order; adds a ref to avoid a stale closure. More moving parts for the same
outcome, and the state then lies (still `ready`/`jit` with a dead invoice). Effort: Small.
Risk: subtle — the expired flip must still happen when editing ends.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`, `src/pages/Receive.test.tsx`.

## Acceptance Criteria

- [x] Expiry passing while the numpad is open does not replace the numpad.
- [x] Cancelling the edit after expiry lands on the expired screen, not a dead QR.
- [x] Existing expired-flow test still passes; new test covers the mid-edit case.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (kieran-typescript-reviewer).
- 2026-07-08: Fixed on the PR branch (variant of Option A): guarded the `jit-expired` render branch with `!editingAmount` — editing is the only state that can coexist with `jit-expired`, so the numpad wins while open and Cancel lands on the expired screen. New mid-edit test.
