---
status: pending
priority: p2
issue_id: "065"
tags: [code-review, quality]
dependencies: []
---

# Error classification duplicated via fragile string matching

## Problem Statement

Error messages from BDK are classified in two places: `mapSendError` in context.tsx (translates BDK errors to user messages) and `validateAndReview` in Send.tsx (re-classifies by substring matching). This duplication is fragile and could break if BDK changes error messages.

## Findings

**Locations:**
- `src/onchain/context.tsx`, lines 54-71 (mapSendError)
- `src/pages/Send.tsx`, lines 84-92 and 129-138 (catch blocks with msg.includes())

Flagged by: kieran-typescript-reviewer, architecture-strategist, agent-native-reviewer

## Proposed Solutions

### Option A: Typed error classes (Recommended)
Throw structured errors with a `code` field from context layer. UI branches on code instead of string matching.

- Pros: Type-safe, no fragile string matching, agents can branch on codes too
- Cons: More error classes to define
- Effort: Medium
- Risk: Low

### Option B: Extract classifyEstimateError helper
Keep string matching but extract to a single shared function.

- Pros: Quick fix, reduces duplication
- Cons: Still fragile
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] Error classification logic exists in one place only
- [ ] Send.tsx catch blocks do not use string matching on error messages
