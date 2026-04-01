---
status: complete
priority: p2
issue_id: '198'
tags: [code-review, testing, bip321]
---

# Add unit tests for lno parameter in buildBip321Uri

## Problem Statement

The `lno` parameter and address-less URI path added to `buildBip321Uri` have no test coverage. The `bip321.test.ts` file was not modified in this PR.

## Findings

- `buildBip321Uri({ lno: 'lno1...' })` produces `bitcoin:?lno=lno1...` — untested
- `buildBip321Uri({ address: 'tb1q...', lno: 'lno1...' })` combined form — untested
- `buildBip321Uri({})` edge case returns `'bitcoin:'` — untested
- `buildBip321Uri({ lno: null })` should omit parameter — untested

## Proposed Solutions

### Solution 1: Add test cases to bip321.test.ts (Recommended)

Add 4 test cases covering the above scenarios.

- **Effort**: Small

## Acceptance Criteria

- [ ] Test: lno-only URI produces `bitcoin:?lno=<offer>`
- [ ] Test: address + lno combined URI
- [ ] Test: null/undefined lno omits parameter
- [ ] Test: empty options edge case
