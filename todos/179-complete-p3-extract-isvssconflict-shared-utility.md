---
status: complete
priority: p3
issue_id: '179'
tags: [code-review, quality]
dependencies: []
---

# Extract isVssConflict to shared utility

## Problem Statement

The `isVssConflict` helper is duplicated identically in `persist.ts` (line 47) and `persist-cm.ts` (line 66). Both check `err instanceof VssError && err.errorCode === ErrorCode.CONFLICT_EXCEPTION`.

**Files:** `src/ldk/traits/persist.ts:47`, `src/ldk/storage/persist-cm.ts:66`

## Findings

- Flagged by architecture strategist (PR #38 review)
- Natural home would be `src/ldk/storage/vss-client.ts` as an exported function or method on VssError

## Acceptance Criteria

- [ ] Single `isVssConflict` definition in a shared location
- [ ] Both `persist.ts` and `persist-cm.ts` import from the shared location
