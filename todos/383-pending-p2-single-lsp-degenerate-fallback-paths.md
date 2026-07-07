---
status: pending
priority: p2
issue_id: '383'
tags: [code-review, lsps2, lsp-failover, telemetry, dead-code, pr-167]
dependencies: []
---

# Single-LSP: degenerate buy-phase "fallback" produces spurious flash + misleading telemetry

## Problem Statement

With LQwD removed, `resolveLspContacts()` now hardcodes `fallback: null`
(`src/ldk/lsp/contacts.ts`). The primary/fallback orchestration was deliberately
kept for a future 2nd LSP, but two paths downstream are now not just dormant —
they are **actively reached and degenerate**, undermining the telemetry work this
PR added.

Flagged independently by the simplicity reviewer (#1, Medium), architecture
reviewer (#4, Medium), TypeScript reviewer (P2), and security reviewer (C).

## Findings

**Buy-phase re-quote always misfires (`src/pages/Receive.tsx:461` → `:396-424`):**
Every successful quote is stamped `role: 'primary'` (the `role: 'fallback'` return
in `runJitQuoteFlow` is unreachable). So on any buy failure, `quote.role === 'primary'`
is always true → `reQuoteSkippingPrimary()` → `runJitQuoteFlow({ skipPrimary: true })`
→ `contacts = { primary: null, fallback: null }` → immediate throw
`'LSP not configured'` (`context.tsx:478`). Net effect:

- a spurious `jit-buying → jit-quoting → jit-error` UI flicker instead of going
  straight to `jit-error`; and
- a **false** incident-log line `'JIT fallback quote failed'` (`Receive.tsx:419`)
  claiming a fallback attempt that never existed — directly at odds with this PR's
  goal of trustworthy failure telemetry.

**Unreachable orchestration branch with a footgun (`context.tsx:540-552`):**
The `else` ("primary discovery failed") branch handles `primary === null &&
fallback !== null`, logs `trigger: 'http_preflight'`, and dereferences
`contacts.fallback!` twice. It is unreachable now (the `:478` guard fires first),
its comment still narrates the deleted LQwD HTTP `/get_info` preflight, and the
non-null assertions would `TypeError` if the fallback slot were ever partially
repopulated.

The quote-phase orchestration + `jit-failover.test.ts` (kept via dependency
injection) are fine — this finding is specifically about the _reachable degenerate
path_ and the _stale/footgun branch_, which the "keep the machinery" decision does
not actually cover.

## Proposed Solutions

### Option A: Gate the buy-phase re-quote on a real fallback

Only take the `reQuoteSkippingPrimary` path when a fallback actually exists (thread
a `hasFallback` signal, or check before re-quoting); otherwise go straight to
`jit-error`. Delete/guard the `http_preflight` else branch and replace the
`fallback!` assertions with a real guard. Preserves the future-2nd-LSP seam.
Effort: Small–Medium.

### Option B: Remove the buy-phase fallback machinery entirely

Drop `reQuoteSkippingPrimary` / `skipPrimary` / `role` stamping; reintroduce from
git history when a 2nd LSP lands. Simplest runtime, but discards tested scaffolding
the team chose to keep. Effort: Medium.

## Recommended Action

(Triage) Option A — removes the spurious flash and the false telemetry while
keeping the failover seam the team deliberately retained.

## Technical Details

- **Affected files**: `src/pages/Receive.tsx` (buy-phase re-quote, `role: 'fallback'`
  UI banner at `:661`), `src/ldk/context.tsx:540-552` (dead else branch), and the
  `skipPrimary` handling at `context.tsx:473-480`.

## Acceptance Criteria

- [ ] A buy failure with no configured fallback goes straight to `jit-error` with
      no intermediate `jit-quoting` flash.
- [ ] No `'JIT fallback quote failed'` telemetry is emitted when no fallback exists.
- [ ] The unreachable `http_preflight` branch is removed or guarded (no `fallback!`
      dereference that can `TypeError`).
- [ ] Re-adding a 2nd LSP (populating `fallback`) restores the failover behavior;
      `jit-failover.test.ts` still passes.

## Work Log

- 2026-07-07: Filed from `/ce:review` (delta review) of PR #167.
