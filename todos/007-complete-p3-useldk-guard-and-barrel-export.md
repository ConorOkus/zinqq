---
status: complete
priority: p3
issue_id: '007'
tags: [code-review, quality, architecture]
dependencies: []
---

# Add useLdk() guard and barrel index.ts

## Items

1. `useLdk()` should throw if used outside `LdkProvider` (currently returns silent default)
2. Add `src/ldk/index.ts` barrel file to formalize public API surface

## Acceptance Criteria

- [ ] `useLdk()` throws descriptive error when used outside provider
- [ ] `src/ldk/index.ts` exists, exports only public API
- [ ] Internal modules not directly importable by convention
