---
status: complete
priority: p2
issue_id: "073"
tags: [code-review, quality]
dependencies: []
---

# Remove redundant pubkey length check in parsePeerAddress

## Problem Statement

`parsePeerAddress` in `src/ldk/peers/peer-connection.ts` checks `pubkey.length !== 66` on line 132, then immediately checks `!/^[0-9a-f]{66}$/.test(pubkey)` on line 135. The regex already enforces exactly 66 lowercase hex characters, making the length check fully redundant.

## Findings

- **File:** `src/ldk/peers/peer-connection.ts`, lines 132-137
- **Identified by:** kieran-typescript-reviewer, code-simplicity-reviewer
- Consolidate into a single regex check with a combined error message

## Acceptance Criteria

- [ ] Remove the `pubkey.length !== 66` check
- [ ] Keep only the regex check with a clear error message
