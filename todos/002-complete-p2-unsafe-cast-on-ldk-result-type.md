---
status: complete
priority: p2
issue_id: '002'
tags: [code-review, quality, type-safety]
dependencies: []
---

# Unsafe `as` cast on LDK Result type

## Problem Statement

In `src/ldk/init.ts` line 60, the LDK `Result_PublicKeyNoneZ` is cast with `as { res: Uint8Array }` — a structural cast with no runtime validation. If LDK bindings change, this silently produces `undefined`.

## Findings

- **File**: `src/ldk/init.ts`, line 60
- Inconsistent with the project's strict TypeScript stance (`noUncheckedIndexedAccess`)
- LDK's `Result_PublicKeyNoneZ_OK` subclass has a `.res` property but the cast bypasses the type hierarchy

## Proposed Solutions

### Option A: Runtime guard (Recommended)

- Check `'res' in nodeIdResult` and validate it's a `Uint8Array` before using
- **Effort**: Small | **Risk**: Low

### Option B: Use LDK's typed subclass

- Cast to `Result_PublicKeyNoneZ_OK` which properly types `.res`
- **Effort**: Small | **Risk**: Low

## Acceptance Criteria

- [ ] No bare `as { res: Uint8Array }` cast
- [ ] Runtime validation or proper typed narrowing
- [ ] Clear error message if the result shape is unexpected
