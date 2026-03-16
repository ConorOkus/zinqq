---
status: complete
priority: p3
issue_id: "014"
tags: [code-review, reliability, security]
dependencies: []
---

# Broadcaster silently drops failed transaction broadcasts

## Problem Statement

`src/ldk/traits/broadcaster.ts` fires and forgets fetch calls to Esplora `/tx`. Failed broadcasts are only logged to console. For justice transactions or commitment transactions, a failed broadcast means fund loss. Needs at minimum a TODO comment, and retry logic before channel management is enabled.

## Acceptance Criteria

- [ ] TODO comment added documenting the retry requirement for pre-channel-management
- [ ] Or: implement retry queue (if channel management is next)
