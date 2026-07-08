---
status: complete
priority: p2
issue_id: '389'
tags: [code-review, receive, lsps2, failover, error-handling, pr-168]
dependencies: []
---

# `JitQuoteFreshnessError` from `executeJitBuy` is misrouted by the generic buy-failure catch

## Problem Statement

PR #168 introduces the first buy-path throw that fires _before any network activity_
(quote went stale while the user idled on Review). `handleGenerateInvoice`'s catch treats
every rejection as "primary LSP unhealthy": today that shows the scary generic
"Could not generate payment request" for a routine staleness event; if a fallback LSP is
ever reintroduced (`HAS_FALLBACK_LSP` flipped true), a purely client-local timing condition
would trigger `reQuoteSkippingPrimary` and demote the user to the fallback's higher fee for
no reason. Flagged by three agents (security-sentinel, kieran-typescript-reviewer,
architecture-strategist — the latter rated it the one thing worth fixing in this PR).

## Findings

- Catch site: `src/pages/Receive.tsx:487-491` — no `instanceof` discrimination;
  `HAS_FALLBACK_LSP && quote.role === 'primary'` → `reQuoteSkippingPrimary`.
- Inert today: `HAS_FALLBACK_LSP = false` (`src/ldk/lsp/contacts.ts:27`), so the throw lands
  on `jit-error` → retry re-quotes primary. Correct behavior, wrong copy.
- Phase A built `classifyJitTrigger` precisely to make failover trigger-aware; the Phase B
  catch discards the type.
- The throw happens before `selectOpeningParams`, so retrying the same LSP is safe and free
  (no orphaned reservation).

## Proposed Solutions

### Option A (recommended): Catch `JitQuoteFreshnessError` specifically

In `handleGenerateInvoice`'s catch: `if (err instanceof JitQuoteFreshnessError)` →
re-quote the same amount WITHOUT `skipPrimary` (straight to `jit-quoting`), reserving the
skip-primary path for transport/RPC/buy-response failures. Optionally route to the
`jit-expired` screen copy instead of `jit-error`. Effort: Small. Risk: low.

### Option B: Defer until a fallback LSP exists

Accept today's generic error screen; fix when `HAS_FALLBACK_LSP` flips. Cheaper now, but the
invariant is fresh in context and the UX copy is wrong today too. Effort: none now.
Risk: forgotten invariant.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`, `src/pages/Receive.test.tsx`.
- Import `JitQuoteFreshnessError` from `src/ldk/context.tsx` (already exported).

## Acceptance Criteria

- [x] A `JitQuoteFreshnessError` rejection from `executeJitBuy` triggers a plain re-quote
      (no `skipPrimary`), not the generic error screen.
- [x] Test: buy rejecting with `JitQuoteFreshnessError` → `requestJitQuote` called again
      without `{ skipPrimary: true }`.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (three agents converged).
- 2026-07-08: Fixed on the PR branch (Option A): generalized `reQuoteSkippingPrimary` →
  `reQuote(amountSats, opts?)`; `handleGenerateInvoice` catch discriminates
  `instanceof JitQuoteFreshnessError` → plain re-quote before the skip-primary path. New test.
