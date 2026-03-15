---
status: complete
priority: p2
issue_id: "077"
tags: [code-review, reliability]
dependencies: []
---

# tickCount increments before NetworkGraph/Scorer persistence — no retry on failure

## Problem Statement

In the sync loop, `tickCount++` on line 137 runs before the NetworkGraph and Scorer `idbPut` calls. If either write fails, the counter has already advanced and the retry will not fire for another 10 ticks (5 minutes). Moving the increment after the writes gives immediate retry on the next tick.

## Findings

- **File:** `src/ldk/sync/chain-sync.ts`, line 137
- **Identified by:** architecture-strategist (Recommendation 2)

## Acceptance Criteria

- [ ] Move `tickCount++` to after the NetworkGraph + Scorer `idbPut` calls
