---
status: complete
priority: p2
issue_id: "082"
tags: [code-review, typescript, type-safety]
dependencies: []
---

# Use string literal union type for Numpad key prop

## Problem Statement

The `onKey` prop in `Numpad.tsx` accepts `string` but only ever emits `'0'`-`'9'` or `'backspace'`. A string literal union would be self-documenting and prevent bugs at the type level.

## Findings

- **File:** `src/components/Numpad.tsx`, `NumpadProps` interface
- **File:** `src/pages/Send.tsx`, `handleNumpadKey` callback
- **Identified by:** kieran-typescript-reviewer (High-3)

## Acceptance Criteria

- [ ] Define `type NumpadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'backspace'`
- [ ] Update `NumpadProps.onKey` and `handleNumpadKey` to use `NumpadKey`
