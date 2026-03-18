---
status: pending
priority: p3
issue_id: 148
tags: [code-review, security]
dependencies: []
---

# Add pagination upper bound to listKeyVersions

## Problem Statement

The `listKeyVersions` do/while loop has no max iteration count. A malicious VSS server could return non-empty `nextPageToken` indefinitely, causing infinite requests. The server is explicitly untrusted in the threat model.

## Findings

- `src/ldk/storage/vss-client.ts:240-276` — unbounded pagination loop

## Proposed Solutions

Add `MAX_PAGES = 100` counter with an error if exceeded.

- **Effort**: Small
- **Risk**: None

## Acceptance Criteria

- [ ] Loop exits after MAX_PAGES with a VssError
- [ ] Test covers the max-page scenario
