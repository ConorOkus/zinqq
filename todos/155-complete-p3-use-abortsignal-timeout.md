---
status: complete
priority: p3
issue_id: '155'
tags: [code-review, quality]
dependencies: []
---

# Simplify timeout management with AbortSignal.timeout()

## Problem Statement

`resolveAddress` in Send.tsx uses manual `setTimeout` + `AbortController` + multiple `clearTimeout` calls for timeout handling. `AbortSignal.timeout()` is a standard Web API that eliminates this ceremony.

**File:** `src/pages/Send.tsx` lines 171-175

## Proposed Solutions

Replace manual timeout with:

```typescript
const signal = AbortSignal.timeout(RESOLVE_TIMEOUT_MS)
```

Or if external cancellation is still needed:

```typescript
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RESOLVE_TIMEOUT_MS)])
```

- Effort: Small
- Risk: Low (requires modern browser support, which this project already assumes)

## Acceptance Criteria

- [ ] Manual setTimeout/clearTimeout replaced with AbortSignal.timeout()
- [ ] External cancel button still works via AbortController
