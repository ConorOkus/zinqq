---
status: complete
priority: p3
issue_id: '165'
tags: [code-review, quality]
dependencies: []
---

# Extract shared numpad digit reducer

## Problem Statement

The same 6-line digit reducer logic is duplicated in three files: `Send.tsx`, `OpenChannel.tsx`, and now `Receive.tsx`. Each copies the same backspace, max-digits, leading-zero, and append logic.

**Files:** `src/pages/Send.tsx:138-149`, `src/pages/OpenChannel.tsx:82-92`, `src/pages/Receive.tsx:118-127`

## Findings

- Pre-existing duplication — PR #36 adds a third copy
- Flagged by simplicity reviewer and architecture strategist
- All three use the same MAX_DIGITS=8 constant

## Acceptance Criteria

- [ ] Shared `numpadDigitReducer(prev, key, maxDigits?)` exported from `src/components/Numpad.tsx` or a shared utils file
- [ ] All three consumers use the shared reducer
- [ ] Existing tests still pass
