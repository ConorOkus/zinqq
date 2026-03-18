---
status: complete
priority: p2
issue_id: "057"
tags: [code-review, quality, react-patterns]
dependencies: []
---

# Narrow useEffect dependency in Receive.tsx

## Problem Statement

The address generation `useEffect` in `Receive.tsx` depends on the entire `onchain` context object, which gets a new reference on every 30-second balance sync tick. The `address === null` guard prevents re-generation, but the pattern is fragile and contradicts the documented learnings in `docs/solutions/integration-issues/bdk-wasm-onchain-wallet-integration-patterns.md` about avoiding full context objects in effect dependencies.

## Findings

**Location:** `src/pages/Receive.tsx`, lines 11-15

```tsx
useEffect(() => {
  if (onchain.status === 'ready' && address === null) {
    setAddress(onchain.generateAddress())
  }
}, [onchain, address])
```

The `onchain` dependency fires on every balance update from the sync loop. While functionally correct today (the null guard prevents re-execution), it is the same anti-pattern that caused the infinite re-render loop fixed in commit ec5d4c6.

Flagged by: kieran-typescript-reviewer, architecture-strategist, learnings-researcher

## Proposed Solutions

### Option A: Extract generateAddress into a stable reference (Recommended)

```tsx
const generateAddress = onchain.status === 'ready' ? onchain.generateAddress : null

useEffect(() => {
  if (generateAddress && address === null) {
    setAddress(generateAddress())
  }
}, [generateAddress, address])
```

- **Pros:** Explicit, stable dependency; matches documented pattern
- **Cons:** None
- **Effort:** Small (5 min)
- **Risk:** None

## Acceptance Criteria

- [ ] `useEffect` does not depend on entire `onchain` context object
- [ ] Address still generated once on mount when status is ready
- [ ] Tests still pass
