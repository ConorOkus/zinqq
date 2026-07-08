---
status: pending
priority: p3
issue_id: '394'
tags: [code-review, receive, mobile, timers, pr-168]
dependencies: []
---

# Expiry timer has no resume resync — throttled background tabs can show a dead QR briefly

## Problem Statement

Mobile browsers freeze/throttle timers in suspended tabs. If the tab is backgrounded across
the expiry deadline, the `jit-expired` flip is delayed until the throttled timeout fires
after resume — a dead QR can be visible for that window. Counterpoint from
architecture-strategist: the QR isn't visible while backgrounded and the flip happens
shortly after resume, so this may not be worth fixing; kieran-typescript-reviewer flagged
the resume gap as real. Filed for triage with both views.

## Findings

- Timer effect: `src/pages/Receive.tsx:271-282` — single `setTimeout`, correct cleanup, no
  `visibilitychange` handling.
- This is the codebase's first wall-clock-deadline timer (existing timers are short UX
  timers: Scan.tsx:82, Backup.tsx:50, copied-toast).

## Proposed Solutions

### Option A: `visibilitychange` resync

In the same effect, add a `visibilitychange` listener that flips immediately when
`document.visibilityState === 'visible' && Date.now() >= invoiceExpiresAt`. Effort: Small.
Risk: none.

### Option B: Accept the delay

Document the known limitation in the effect comment. Effort: Trivial.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`.

## Acceptance Criteria

- [ ] Returning to a backgrounded tab past the deadline shows the expired screen without
      waiting for the throttled timer (if Option A).

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (kieran-typescript-reviewer; counterpoint
  architecture-strategist).
