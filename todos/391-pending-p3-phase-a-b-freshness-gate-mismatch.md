---
status: pending
priority: p3
issue_id: '391'
tags: [code-review, lsps2, receive, pr-168]
dependencies: []
---

# Phase A accepts quotes (≥30s) that Phase B is guaranteed to reject (≥90s)

## Problem Statement

Phase A's freshness gate accepts a quote with ≥30s of validity; the new Phase B gate
requires ≥90s (60s min invoice life + 30s flight margin). A quote arriving with 30–89s of
validity passes Phase A, renders the Review screen, and is structurally doomed: Generate
will throw `JitQuoteFreshnessError` the instant it's tapped. Unlikely with Megalith's
observed 10–15 min validity, but the layering shouldn't permit a display-but-never-
committable window.

## Findings

- Phase A gate: `src/ldk/context.tsx:337` — magic `30_000`.
- Phase B gate: `src/ldk/context.tsx:373-376` — `JIT_INVOICE_MIN_EXPIRY_SECS (60) +
  JIT_INVOICE_FLIGHT_MARGIN_SECS (30)` effective threshold.
- The updated comment at `:333-336` cross-references the stricter downstream check but does
  not align the upstream one.

## Proposed Solutions

### Option A (recommended): Raise Phase A to the Phase B threshold + dwell headroom

Replace the magic `30_000` with
`(JIT_INVOICE_MIN_EXPIRY_SECS + JIT_INVOICE_FLIGHT_MARGIN_SECS) * 1000` (optionally plus a
Review-screen dwell allowance, e.g. +30s). Reuses the constants; failover
(`quote_freshness` trigger) then rolls to the fallback for a quote that can't be committed.
Effort: Trivial. Risk: none.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`, `src/ldk/lsp/jit-failover.test.ts` (freshness
  fallback test uses the 30s boundary).

## Acceptance Criteria

- [ ] Phase A threshold ≥ Phase B threshold, expressed via the shared constants.
- [ ] Freshness-fallback test updated to the new boundary.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (architecture-strategist).
