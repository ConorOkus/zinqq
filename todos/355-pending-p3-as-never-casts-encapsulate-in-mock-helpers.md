---
status: pending
priority: p3
issue_id: '355'
tags: [code-review, typescript, tests, pr-160]
dependencies: []
---

# `as never` casts in tests should be encapsulated in mock helpers

## Problem Statement

`persist-cm.test.ts` has repeated `cm as never` casts at every test site.
The mock helpers `makeCm()` and `makeDirtyCm()` already type their return
as `as never` (line 24), but call sites still need a second cast because
the helpers' return types don't carry the `ChannelManager` brand.

Per Kieran's TypeScript review: `as never` is the wrong escape hatch.
`as unknown as X` is the conventional double-cast and more honest. Better:
encapsulate the cast inside the helper so call sites are clean.

## Findings

- kieran-typescript-reviewer P3

## Proposed Solutions

```ts
function makeDirtyCm(data = new Uint8Array([1, 2, 3])): ChannelManager & { setDirty: () => void } {
  // ... existing impl
  return { write: ..., get_and_clear_needs_persistence: ..., setDirty: ... } as unknown as ChannelManager & { setDirty: () => void }
}
```

Then drop every `cm as never` at the test bodies.

- Pros: cleaner call sites; correct cast idiom.
- Effort: Small.
- Risk: None.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.test.ts`

## Acceptance Criteria

- [ ] No `as never` in test call sites; cast lives in mock helpers

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/160
