---
status: complete
priority: p2
issue_id: '003'
tags: [code-review, quality, type-safety, architecture]
dependencies: []
---

# LdkContextValue should be a discriminated union

## Problem Statement

`LdkContextValue` in `src/ldk/ldk-context.ts` allows impossible states like `{ status: 'ready', node: null }`. A discriminated union would let TypeScript narrow correctly and eliminate redundant null checks in consumers.

## Findings

- **File**: `src/ldk/ldk-context.ts`, lines 4-11
- `Home.tsx` already does `status === 'ready' && nodeId` — the `&& nodeId` guard would be unnecessary with proper narrowing
- Three distinct states: loading, ready (with node), error (with error)

## Proposed Solutions

### Option A: Discriminated union type (Recommended)

```
type LdkContextValue =
  | { status: 'loading'; node: null; nodeId: null; error: null }
  | { status: 'ready'; node: LdkNode; nodeId: string; error: null }
  | { status: 'error'; node: null; nodeId: null; error: Error }
```

- **Effort**: Small | **Risk**: Low

## Acceptance Criteria

- [ ] `LdkContextValue` is a discriminated union
- [ ] Consumers don't need redundant null checks after status narrowing
- [ ] `createContext` default uses the loading variant
