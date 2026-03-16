---
status: complete
priority: p3
issue_id: "030"
tags: [code-review, reliability]
dependencies: []
---

# No timeout on Esplora fetch calls

## Problem Statement

All `fetch()` calls in `EsploraClient` have no `AbortSignal` timeout. If Esplora is slow, the sync loop hangs on a single HTTP call until the browser gives up (minutes).

## Findings

- **Source:** TypeScript Reviewer, Security Sentinel (L1)
- **Location:** `src/ldk/sync/esplora-client.ts` — all fetch calls

## Proposed Solutions

Add `{ signal: AbortSignal.timeout(15_000) }` to all fetch calls.

## Acceptance Criteria

- [ ] All Esplora fetch calls have a timeout (10-15s)
- [ ] Timeout errors are catchable by the sync loop

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
