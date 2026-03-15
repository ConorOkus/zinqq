---
status: complete
priority: p2
issue_id: "054"
tags: [code-review, quality, typescript]
dependencies: []
---

# Fix double response.text() consumption in broadcastTransaction

## Problem Statement

`broadcastTransaction` calls `response.text()` twice — once in the error path and once in the happy path. While this works today (error path returns early), it's a code smell. The happy path also doesn't `await` the text, returning a bare promise.

## Findings

- **Source**: kieran-typescript-reviewer
- **File**: `src/onchain/tx-bridge.ts:31-35`
- Read body once, await consistently

## Proposed Solutions

```typescript
const body = await response.text()
if (!response.ok) {
    throw new Error(`Esplora broadcast failed: ${response.status} ${body}`)
}
return body
```

**Effort**: Small (3-line change)

## Acceptance Criteria

- [ ] `response.text()` called once
- [ ] Consistent `await` usage

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-12 | Identified during PR #8 code review | |

## Resources

- PR: #8
