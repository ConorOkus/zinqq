---
title: 'refactor: Remove protocol details from Lightning send screens'
type: refactor
status: completed
date: 2026-03-27
origin: docs/brainstorms/2026-03-27-send-flow-ui-cleanup-brainstorm.md
---

# Remove Protocol Details from Lightning Send Screens

## Overview

Strip implementation-facing details from the Lightning send flow to create a cleaner, rail-agnostic experience. Three elements are removed; one label is unified with the on-chain success screen.

(see brainstorm: docs/brainstorms/2026-03-27-send-flow-ui-cleanup-brainstorm.md)

## Changes

### 1. Remove "Type" row from ln-review screen

**File:** `src/pages/Send.tsx:887-892`

Delete the entire `<div className="flex justify-between">` block that renders the "Type" label and `typeBadge(parsed)` BOLT 11/12 badge.

### 2. Remove `typeBadge()` helper function

**File:** `src/pages/Send.tsx:102-110`

Delete the `typeBadge` function definition. It's only called from the Type row being removed — confirmed via grep (two occurrences: definition + single call site).

### 3. Change "sent via Lightning" → "sent successfully"

**File:** `src/pages/Send.tsx:732`

Replace:

```tsx
<div className="mt-1 text-[var(--color-on-dark-muted)]">sent via Lightning</div>
```

With:

```tsx
<div className="mt-1 text-[var(--color-on-dark-muted)]">sent successfully</div>
```

This matches the existing oc-success screen text at line 694.

### 4. Remove preimage hex button from ln-success

**File:** `src/pages/Send.tsx:734-741`

Delete the entire conditional block:

```tsx
{preimageHex !== '0'.repeat(64) && (
  <button ...>{preimageHex.slice(0, 8)}...{preimageHex.slice(-8)}</button>
)}
```

Also remove the `const preimageHex = bytesToHex(sendStep.preimage)` line at 722, since it becomes unused.

## What NOT to Change

- `preimage` field in the `SendStep` type union and state transitions — may be needed internally
- On-chain success screen (explorer link, txid display remain)
- All other ln-review rows (To, Amount)
- `bytesToHex` import — verify it's still used elsewhere before removing

## Test Updates

**File:** `src/pages/Send.test.tsx`

Two test assertions reference `BOLT 11` (lines 363, 409). These assertions should be **removed** since the Type badge no longer renders. The tests themselves should still verify the review screen renders correctly (To, Amount) — just without the Type assertion.

## Acceptance Criteria

- [x] ln-review screen shows only "To" and "Amount" rows (no "Type" row)
- [x] ln-success screen shows "sent successfully" instead of "sent via Lightning"
- [x] ln-success screen has no preimage hex button
- [x] oc-review and oc-success screens are unchanged
- [x] `typeBadge` function is removed (no dead code)
- [x] Existing tests pass after removing `BOLT 11` assertions
- [x] No unused imports left behind

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-27-send-flow-ui-cleanup-brainstorm.md](docs/brainstorms/2026-03-27-send-flow-ui-cleanup-brainstorm.md) — Key decisions: on-chain screens unchanged, unify success text, remove typeBadge as dead code
