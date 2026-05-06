---
status: pending
priority: p2
issue_id: '311'
tags: [code-review, simplicity, performance, pr-150]
dependencies: []
---

# `<link rel="preconnect">` to `window.location.origin` is a no-op

## Problem Statement

The Receive page mounts a `<link rel="preconnect" href={window.location.origin}>` in a `useEffect`. Preconnect to your own origin warms nothing — that's the connection the document was just served over. The plan justified the change as a "lightweight latency win" for the LSP same-origin proxy, but since the LSP traffic shares the document's origin (it's proxied through `/api/...`), the connection pool is already warm.

## Findings

- **File**: `src/pages/Receive.tsx:285-298` (~14 LOC)
- **Identified by**: code-simplicity-reviewer (#3), architecture-strategist (cross-cutting)
- The plan said "preconnect to LSP proxy origin"; same-origin proxy means the hint targets the wrong thing
- A real preconnect would point at the upstream LSP/Esplora origin — but those go through our proxy, so we can't preconnect to them from the browser anyway

## Proposed Solutions

### Option A: Remove the effect (Recommended)

- Delete the entire `useEffect` block
- **Pros**: ~14 LOC saved; no false performance promise
- **Cons**: Loses an "intent" marker for future preconnect work
- **Effort**: Tiny
- **Risk**: None

### Option B: Move to `index.html` as a static `<link>`, pointing at the right origin

- Identify any external origin (e.g., Esplora upstream) the page calls and add a real preconnect
- **Pros**: Actual latency win
- **Cons**: Needs to know which origin matters; same-origin proxy may make this moot
- **Effort**: Small (research + 1-line HTML)

## Recommended Action

(Filled during triage — Option A is the safe default)

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`

## Acceptance Criteria

- [ ] No-op preconnect effect removed
- [ ] If replaced (Option B): the new preconnect targets a non-same-origin host AND there's evidence (network panel) of latency reduction
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
