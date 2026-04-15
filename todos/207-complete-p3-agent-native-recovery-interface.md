---
status: pending
priority: p3
issue_id: '207'
tags: [code-review, agent-native, recovery]
dependencies: []
---

# Expose recovery state for agent-native access

## Problem Statement

All recovery capabilities are UI-only. An AI agent cannot check recovery status, get the deposit address, or dismiss the banner. The primitives (`readRecoveryState`, `clearRecoveryState`) are well-structured exported functions but have no non-UI surface.

## Findings

**Source:** agent-native-reviewer

## Proposed Solutions

### Option A: Expose via agent tools / system prompt context

- Surface recovery status in the agent's system prompt
- Add MCP tools for `readRecoveryState` and `clearRecoveryState`
- **Effort:** Medium | **Risk:** Low

## Acceptance Criteria

- [ ] An agent can programmatically check if recovery is needed
- [ ] An agent can read the deposit address
- [ ] An agent can dismiss the success banner

## Work Log

| Date       | Action                           | Learnings                                 |
| ---------- | -------------------------------- | ----------------------------------------- |
| 2026-04-14 | Created from PR #128 code review | Primitives exist, just need non-UI wiring |

## Resources

- PR: #128
- Files: `src/ldk/recovery/recovery-state.ts`, `src/ldk/recovery/use-recovery.ts`
