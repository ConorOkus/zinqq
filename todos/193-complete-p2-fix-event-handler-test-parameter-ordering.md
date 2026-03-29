---
status: complete
priority: p2
issue_id: '193'
tags: [code-review, quality, lsps2]
---

# Fix event handler test parameter ordering

## Problem Statement

The "calls onSyncNeeded when channel closes" test in `event-handler.test.ts` passes arguments in the wrong order, causing `mockSyncNeeded` to be wired as `onChannelClosed` instead of `onSyncNeeded`. The test passes by accident because `ChannelClosed` triggers `onChannelClosed`, which happens to be the mock.

## Findings

- **TS reviewer finding 15:** At line 454, `undefined` is passed as `lspNodeId` (4th param), `undefined` as `onPaymentEvent` (5th), and `mockSyncNeeded` as `onChannelClosed` (6th). The test name is misleading — it tests `onChannelClosed`, not `onSyncNeeded`.

## Proposed Solutions

1. **Fix parameter ordering** — Pass `mockSyncNeeded` in the correct position (7th param for `onSyncNeeded`).
   - Effort: Trivial
   - Risk: Low

## Technical Details

- **Affected files:** `src/ldk/traits/event-handler.test.ts` (line ~449-464)
- **Effort:** Trivial

## Acceptance Criteria

- [ ] Test correctly wires `mockSyncNeeded` as the `onSyncNeeded` callback
- [ ] Test name accurately reflects what it tests

## Resources

- Branch: feat/lsps2-jit-channel-receive
