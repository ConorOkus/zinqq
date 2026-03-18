---
status: pending
priority: p3
issue_id: '108'
tags: [code-review, quality]
dependencies: []
---

# `isNewWallet` is dead code after always-full-scan change

## Problem Statement

`isNewWallet` on the `BdkWallet` interface in `src/onchain/init.ts` was used to decide between full scan and incremental sync. After the change to always full-scan, this field is never consumed. It should be removed.

## Proposed Solution

Delete `isNewWallet` from the `BdkWallet` interface and all assignments.

- **Effort**: Trivial (~6 LOC)

## Acceptance Criteria

- [ ] `isNewWallet` removed from `BdkWallet` interface and all assignments
