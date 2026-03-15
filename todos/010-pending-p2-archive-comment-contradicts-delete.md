---
status: complete
priority: p2
issue_id: "010"
tags: [code-review, quality]
dependencies: []
---

# archive_persisted_channel comment says "archive" but code deletes

## Problem Statement

In `src/ldk/traits/persist.ts` line 56, the comment says "Move to an archived prefix rather than deleting" but the implementation calls `idbDelete`. This directly contradicts the code behavior. Misleading comments in persistence code for a Lightning wallet are a maintenance hazard.

## Acceptance Criteria

- [ ] Comment updated to match actual behavior: "Delete the channel monitor (archival not implemented)"
