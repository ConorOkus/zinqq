---
status: complete
priority: p2
issue_id: '004'
tags: [code-review, security]
dependencies: []
---

# generateAndStoreSeed has no existing-seed guard

## Problem Statement

`generateAndStoreSeed()` in `src/ldk/storage/seed.ts` unconditionally overwrites whatever is at the `'primary'` key. Any misuse (calling it when a seed exists) permanently destroys access to funds in channels opened with the previous seed.

## Findings

- **File**: `src/ldk/storage/seed.ts`, lines 10-14
- `initializeLdk()` correctly checks first, but `generateAndStoreSeed` is exported and callable by anyone
- Seed overwrite = total fund loss

## Proposed Solutions

### Option A: Guard in generateAndStoreSeed (Recommended)

- Check for existing seed and throw if one exists
- Add a separate `forceRegenerateSeed()` for intentional rotation
- **Effort**: Small | **Risk**: Low

### Option B: Make generateAndStoreSeed unexported

- Only export `getOrCreateSeed()` which combines the check + generate
- **Effort**: Small | **Risk**: Low

## Acceptance Criteria

- [ ] Calling `generateAndStoreSeed()` when a seed exists throws an error
- [ ] Or the function is unexported / replaced with a safe alternative
