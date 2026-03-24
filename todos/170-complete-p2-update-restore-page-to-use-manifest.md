---
status: complete
priority: p2
issue_id: '170'
tags: [code-review, feature]
dependencies: []
---

# Update Restore.tsx to use \_monitor_keys manifest

## Problem Statement

The manual "Recover Wallet" page (`Restore.tsx`) has a TODO about needing a manifest to fetch monitors by plaintext keys. PR #37 introduces exactly that manifest (`_monitor_keys`), but `Restore.tsx` was not updated to use it. The manual restore path still cannot recover channel monitors.

**Files:** `src/pages/Restore.tsx:101-119`

## Findings

- Flagged by agent-native reviewer
- The recovery logic in `init.ts:176-187` could be extracted into a shared utility
- The TODO comment at `Restore.tsx:119` is now stale — it asks for exactly what this PR implements

## Acceptance Criteria

- [ ] `Restore.tsx` reads `_monitor_keys` from VSS and fetches each monitor
- [ ] Consider extracting shared `recoverFromVss(vssClient)` utility used by both init.ts and Restore.tsx
- [ ] The stale TODO comment in Restore.tsx is updated or removed
