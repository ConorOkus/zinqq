---
status: pending
priority: p2
issue_id: '368'
tags: [lsps2, jit-receive, lsp-failover, ux, latency]
dependencies: []
---

# JIT buy-phase fallback only fires after the full 30s LSPS2 timeout

## Problem Statement

The buy-phase fallback added in `feat/jit-buy-phase-fallback-and-min-receive-gate`
correctly recovers from a primary-LSP buy failure by re-quoting the fallback
LSP (`Receive.tsx` `reQuoteSkippingPrimary` → `runJitQuoteFlow({ skipPrimary })`).
But it only triggers once `executeJitBuy` rejects, and the only way an
`lsps2.buy` rejects on a silent LSP is the **30 s reaper** in
`src/ldk/lsps2/message-handler.ts:36` (`REQUEST_TIMEOUT_MS = 30_000`).

So when the primary LSP (LQwD) answers `get_info` but never answers
`lsps2.buy` — the exact failure observed in testing — the user stares at the
`jit-buying` spinner for a full 30 seconds before the fallback even begins,
then waits again for the fallback's connect + quote + buy. Real-world cold
recovery is ~30–40 s. That reads as "frozen" and most users will abandon.

## Findings

- A buy that will ultimately fall back wastes the entire `REQUEST_TIMEOUT_MS`
  budget doing nothing observable.
- `get_info` for the same LSP returns quickly, so a per-call short-circuit is
  feasible — a buy timeout could be much shorter than 30 s without risking
  false negatives on a healthy LSP (LSPS2 buys that succeed return in well
  under a second in the working Megalith case).

## Proposed Solutions

### Option A: Shorter, buy-specific timeout
Give `lsps2.buy` its own (shorter, e.g. 8–10 s) deadline distinct from the
30 s default, after which we fall back. Simplest; needs the deadline plumbed
per-request rather than the single global reaper interval.

### Option B: Health-gate the primary
Track that the primary's last buy timed out and skip it (go straight to
`skipPrimary`) for a cooldown window, so repeat receives in a degraded session
don't re-pay the timeout each time.

### Option C: Both — short buy timeout + primary cooldown
Best UX; most scope.

## Recommended Action

(Triage) Lean Option A first (bounded blast radius), Option B as a follow-up.

## Technical Details

- **Affected files**: `src/ldk/lsps2/message-handler.ts` (per-request timeout),
  `src/pages/Receive.tsx` (fallback trigger), `src/ldk/context.tsx`
  (`executeJitBuy`).
- **Components**: LSPS2 buy, JIT receive fallback.

## Acceptance Criteria

- [ ] A silent-on-buy primary LSP falls back to the fallback LSP in well under
      30 s (target ≤ ~10 s before fallback begins).
- [ ] A healthy LSP whose buy legitimately takes a few seconds is NOT
      prematurely abandoned (no false fallback).
- [ ] Unit/timer test pinning the buy-phase deadline.

## Context

Surfaced while testing `feat/jit-buy-phase-fallback-and-min-receive-gate`
against a degraded LQwD endpoint (answers `get_info`, never answers
`lsps2.buy`). The fallback itself works; only its latency is the issue.
