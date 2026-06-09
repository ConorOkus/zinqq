---
status: complete
priority: p3
issue_id: '372'
tags: [code-review, lsps2, jit-receive, config-drift, observability]
dependencies: []
---

# Guard `MIN_JIT_RECEIVE_SATS` against drift from real LSP menu minimums

## Problem Statement

`MIN_JIT_RECEIVE_SATS = 5_000n` (`src/ldk/lsps2/types.ts:119`) is a
hand-maintained envelope over "the effective minimum of every configured LSP"
(doc-comment cites LQwD ~100, Megalith ~2,501). Because quotes are never
pre-fetched on keystrokes (`feedback_no_jit_quote_prewarm.md`), a static numpad
gate is the right _mechanism_ — but the constant can silently diverge from the
LSPs' real menus:

- If a fallback LSP raises its minimum above 5,000, the gate passes amounts the
  fallback rejects at buy time. Combined with the PR #165 fallback path, a
  primary buy failure then re-quotes a fallback that can't service the amount →
  `jit-error` after the user already committed.
- Conversely it over-blocks 100–4,999 sat receives that the primary (LQwD,
  serving most buys) would accept.

Flagged by kieran-typescript (P3) and architecture-strategist (P3).

## Findings

- **File**: `src/ldk/lsps2/types.ts:119`; live menu min already computed by
  `computeMinReceiveSats(menu)` (`types.ts:132`) once a quote is in hand.

## Proposed Solutions

### Option A — Close the loop at quote time (Small, recommended)

When a menu IS fetched (quote phase), assert the static floor still dominates:
`computeMinReceiveSats(menu) <= MIN_JIT_RECEIVE_SATS`. If not, `captureError`
(warning) so drift becomes an observable signal — without violating no-prewarm,
since the check runs on a quote the user already triggered.

### Option B — Co-locate the constant with LSP config (Small)

Move `MIN_JIT_RECEIVE_SATS` next to `LDK_CONFIG`/`resolveLspContacts` so "which
LSPs exist + their floors + the UI floor" is one concern in one place, and
document its provenance as a derived invariant (`>= max(per-LSP effective min)`)
with an LSP-onboarding checklist note.

## Recommended Action

(Triage) Option A first (cheap observability); Option B as tidy-up.

## Technical Details

- **Affected files**: `src/ldk/lsps2/types.ts`, `src/ldk/context.tsx`
  (`runJitQuoteFlow`/quote handling), possibly `src/ldk/config.ts`.

## Acceptance Criteria

- [ ] A live menu minimum exceeding `MIN_JIT_RECEIVE_SATS` produces a logged
      warning (not silent).
- [ ] Constant's provenance documented as a derived invariant.

## Work Log

- 2026-06-09 — Filed from `/ce:review` of PR #165.
- 2026-06-09 — **Resolved via Option A.** `getJitQuote` (`context.tsx`) now
  computes `computeMinReceiveSats(feeMenu)` on every real quote and
  `captureError('warning', …)` if it exceeds `MIN_JIT_RECEIVE_SATS` — turns
  silent drift into an observable signal without violating the no-prewarm rule
  (runs on a quote the user already triggered). Option B (co-locating the
  constant with LSP config) left as optional tidy-up.

## Resources

- PR #165; `feedback_no_jit_quote_prewarm.md`
