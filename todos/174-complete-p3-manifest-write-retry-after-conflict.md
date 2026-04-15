---
status: complete
priority: p3
issue_id: '174'
tags: [code-review, reliability]
dependencies: []
---

# Retry manifest write after conflict resolution in writeManifest

## Problem Statement

In `writeManifest()`, a version conflict triggers a re-fetch of the server version but does not retry the actual write. The corrected version is only used on the _next_ `writeManifest()` call. If a channel is opened and the app is closed before another channel operation triggers a fresh write, VSS could have a stale manifest.

**Files:** `src/ldk/traits/persist.ts:67-87`

## Findings

- Flagged by TypeScript reviewer (C2) and architecture strategist (Issue 4)
- The security review confirmed this is a UX issue (recovery fails instead of succeeding) not a fund-safety issue — LDK's CM deserialization would catch the mismatch
- Self-heals on next `persist_new_channel` or app restart via backfill

## Acceptance Criteria

- [ ] After re-fetching server version on conflict, retry the manifest put once within the same chain link
- [ ] If retry also fails, log warning and proceed (current behavior)
