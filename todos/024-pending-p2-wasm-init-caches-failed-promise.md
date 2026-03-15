---
status: complete
priority: p2
issue_id: "024"
tags: [code-review, reliability]
dependencies: []
---

# WASM init guard caches failed promise permanently

## Problem Statement

If `initializeWasmWebFetch` fails (network error, 404), `wasmInitPromise` caches the rejected promise. All subsequent calls return the same rejection, making the wallet permanently broken until page reload.

## Findings

- **Source:** Security Sentinel (M4)
- **Location:** `src/ldk/init.ts` lines 56-60

## Proposed Solutions

### Option A: Reset promise on rejection
```typescript
wasmInitPromise = initializeWasmWebFetch('/liblightningjs.wasm').catch((err) => {
  wasmInitPromise = null
  throw err
})
```
- **Effort:** Small

## Acceptance Criteria

- [ ] Failed WASM init resets the cached promise
- [ ] Subsequent init attempts can retry

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
