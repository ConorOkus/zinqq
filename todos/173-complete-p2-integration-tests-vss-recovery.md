---
status: complete
priority: p2
issue_id: '173'
tags: [code-review, testing]
dependencies: []
---

# Add integration tests for VSS recovery path

## Problem Statement

The VSS recovery flow (download manifest → fetch monitors → fetch CM → write to IDB → rollback on failure) has no test coverage. This is fund-critical code that coordinates between VSS reads, IDB writes, and atomic rollback. The backfill logic (conflict-aware manifest upload for pre-existing wallets) is also untested.

**Files:** `src/ldk/init.ts:170-242`

## Findings

- Flagged by all four review agents (TypeScript, security, simplicity, architecture)
- `persist-cm.test.ts` exists but no corresponding tests for init-time recovery or backfill
- The recovery path has multiple failure modes (partial download, missing CM, rollback) that should be exercised

## Acceptance Criteria

- [ ] Test: full recovery from VSS when IDB is empty (happy path)
- [ ] Test: partial failure triggers atomic rollback (monitor fetch fails midway)
- [ ] Test: missing ChannelManager aborts recovery and rolls back monitors
- [ ] Test: manifest not found in VSS → falls through to fresh state
- [ ] Test: backfill writes manifest on first startup with existing IDB data
- [ ] Test: backfill handles 409 conflict (manifest already exists)
