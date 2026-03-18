---
status: pending
priority: p2
issue_id: 128
tags: [code-review, testing, agent-native]
dependencies: []
---

# Add checkReceivability to Receive page test mock

## Problem Statement

The `readyLdkContext()` helper in `Receive.test.tsx` does not include `checkReceivability`, which means the Receive component sees it as `undefined` during tests. The new polling logic and Lightning status UI are not tested.

## Findings

- **Agent-Native Reviewer**: Missing mock means new UI states (lightningStatus, staleInvoiceWarning) have no test coverage.

## Proposed Solutions

Add `checkReceivability: vi.fn(() => ({ canReceive: true }))` to `readyLdkContext()`. Add test cases for the three failure reasons and stale invoice warning.

- **Effort**: Small-Medium
- **Risk**: Low

## Technical Details

**Affected files:** `src/pages/Receive.test.tsx`

## Acceptance Criteria

- [ ] `checkReceivability` included in test mock
- [ ] Test for `peer-disconnected` status message
- [ ] Test for stale invoice warning when invoice exists and peer disconnects
- [ ] Test for auto-invoice generation when `canReceive` transitions to true
