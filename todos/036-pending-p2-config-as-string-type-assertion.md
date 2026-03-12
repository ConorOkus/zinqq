---
status: pending
priority: p2
issue_id: "036"
tags: [code-review, quality]
dependencies: []
---

# Unsafe `as string` type assertion in config.ts wsProxyUrl

## Problem Statement

`(import.meta.env.VITE_WS_PROXY_URL as string)` silently lies to the compiler — the value is `string | undefined` at runtime. The assertion also undermines `as const` by widening the type from the literal fallback to `string`.

## Findings

- **Source:** TypeScript Reviewer
- **Location:** `src/ldk/config.ts` line 10

## Proposed Solutions

### Option A: Remove assertion, use `??` (Recommended)
```typescript
wsProxyUrl: import.meta.env.VITE_WS_PROXY_URL ?? 'wss://p.mutinynet.com',
```
- **Effort:** Small — one-line change

## Acceptance Criteria

- [ ] No `as string` assertion on env var access
- [ ] Fallback to public proxy still works when env var is undefined
