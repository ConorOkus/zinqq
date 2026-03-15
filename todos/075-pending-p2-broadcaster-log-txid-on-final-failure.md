---
status: complete
priority: p2
issue_id: "075"
tags: [code-review, quality, observability]
dependencies: []
---

# Broadcaster CRITICAL log does not include txid or txHex

## Problem Statement

After all 5 retry attempts fail, `broadcastWithRetry` logs `CRITICAL: All broadcast attempts failed for tx` with no identifying information. The `txHex` parameter is in scope but not included. When debugging a real failure, this log is useless without knowing which transaction failed.

## Findings

- **File:** `src/ldk/traits/broadcaster.ts`, line 38
- **Identified by:** kieran-typescript-reviewer

## Acceptance Criteria

- [ ] Include truncated txHex (first 16 chars) in the CRITICAL log message
