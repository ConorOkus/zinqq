---
status: pending
priority: p2
issue_id: 146
tags: [code-review, quality]
dependencies: []
---

# Defensively copy headers in FixedHeaderProvider

## Problem Statement

FixedHeaderProvider stores a reference to the passed-in headers object. Callers can mutate the original object after construction, silently changing provider behavior. For something named "Fixed", this is misleading.

## Findings

- `src/ldk/storage/vss-client.ts:23-29` — stores reference, not copy

## Proposed Solutions

Copy in constructor and getHeaders:
```typescript
constructor(headers: Record<string, string>) {
  this.#headers = { ...headers }
}
async getHeaders(): Promise<Record<string, string>> {
  return { ...this.#headers }
}
```

- **Effort**: Small
- **Risk**: None

## Acceptance Criteria

- [ ] Constructor copies headers
- [ ] getHeaders returns a copy
