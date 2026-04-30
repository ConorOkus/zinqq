---
status: pending
priority: p3
issue_id: '290'
tags: [code-review, agent-native, memory, todos]
dependencies: []
---

# Add `MEMORY.md` index pointer to the `cancelled` todo status convention

## Problem Statement

Todo 270's fix documents `cancelled` as a Zinqq-local terminal todo status in `compound-engineering.local.md`. That file is auto-loaded by compound-engineering skills but **not** by ad-hoc todo tooling or non-CE agent sessions. An index pointer in `MEMORY.md` would surface the convention to any future Claude session reading the user's auto-memory, not just CE-skill sessions.

## Findings

- `compound-engineering.local.md` — current home of the convention.
- `~/.claude/projects/-Users-conor-Projects-zinq/memory/MEMORY.md` — auto-memory index, broader reach.
- Flagged by `agent-native-reviewer` during PR #147 follow-up review.

## Proposed Solution

Add a one-line index entry to `MEMORY.md`:

```
- [feedback_cancelled_todo_status.md](feedback_cancelled_todo_status.md) — Cancelled is a Zinqq-local terminal todo status; treat as synonym of complete
```

…and create a matching `feedback_cancelled_todo_status.md` memory pointing at the convention text in `compound-engineering.local.md`.

**Effort:** 10 min.
**Risk:** None.

## Acceptance Criteria

- [ ] `MEMORY.md` carries an index entry pointing at the cancelled-status convention.

## Resources

- **PR:** #147
- **Reviewer:** `agent-native-reviewer`
- **Related:** todo 270

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** agent-native-reviewer
