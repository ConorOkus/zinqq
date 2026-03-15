---
status: complete
priority: p2
issue_id: "056"
tags: [code-review, quality, readability]
dependencies: []
---

# Remove IIFE from Home.tsx balance display

## Problem Statement

The on-chain balance card in `Home.tsx` uses an immediately-invoked function expression (IIFE) inside JSX to compute the `pending` variable. This is an anti-pattern that harms readability and is inconsistent with the rest of the codebase.

## Findings

**Location:** `src/pages/Home.tsx`, lines 49-70

```tsx
{onchain.status === 'ready' && (() => {
  const pending = onchain.balance.trustedPending + onchain.balance.untrustedPending
  return (...)
})()}
```

Flagged by: kieran-typescript-reviewer, code-simplicity-reviewer, architecture-strategist

## Proposed Solutions

### Option A: Compute pending above JSX return (Recommended)

Compute `pending` at the top of the component body after the discriminated union check, then use a plain conditional in JSX.

- **Pros:** Simple, flat JSX, zero abstraction cost
- **Cons:** None
- **Effort:** Small (5 min)
- **Risk:** None

## Acceptance Criteria

- [ ] No IIFE in Home.tsx JSX
- [ ] `pending` computed outside JSX
- [ ] Balance display functionally identical
- [ ] Tests still pass
