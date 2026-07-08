---
status: pending
priority: p3
issue_id: '396'
tags: [code-review, tests, lsps2, receive, pr-168]
dependencies: ['387']
---

# Expiry tests live in the failover test file; two coverage gaps

## Problem Statement

The five `computeJitInvoiceExpirySecs` tests were appended to
`src/ldk/lsp/jit-failover.test.ts`, a file named for a different concern. Two behaviors are
also untested: malformed `valid_until` (the NaN gate — pairs with todo 387, whose fix should
land with this test), and the documented "payment landing mid-flight supersedes the expired
screen with success" precedence.

## Findings

- Test placement: `src/ldk/lsp/jit-failover.test.ts:412-437` (kieran-typescript-reviewer;
  note architecture-strategist considered the placement acceptable as "the established home
  for context.tsx flow functions" — decide either way at triage).
- Coverage gap 1: no NaN/malformed `validUntil` test (would have caught todo 387's bug).
- Coverage gap 2: comment at `src/pages/Receive.tsx:267-270` promises jit-expired → success
  supersession; no test exercises it. (learnings-researcher also suggested asserting the
  expired transition only fires from the JIT QR screen — partially covered by the existing
  expired-flow test.)

## Proposed Solutions

### Option A: Dedicated test file + both gap tests

Move the five tests to `src/ldk/jit-invoice-expiry.test.ts` (or similar); add the NaN test
(with 387's fix) and a Receive test driving paymentHistory to a success match while in
`jit-expired`. Effort: Small.

### Option B: Keep placement, add only the gap tests

Effort: Small (minus the move).

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/ldk/lsp/jit-failover.test.ts`, `src/pages/Receive.test.tsx`.

## Acceptance Criteria

- [ ] Malformed `valid_until` unit test exists and passes (with 387's fix).
- [ ] jit-expired → success supersession test exists and passes.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (kieran-typescript-reviewer +
  learnings-researcher).
