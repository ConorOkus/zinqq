---
status: complete
priority: p3
issue_id: '373'
tags: [code-review, lsps2, jit-receive, lsp-failover, edge-case]
dependencies: []
---

# Buy-phase fallback fires on ambiguous post-send timeout → possible orphaned primary channel

## Problem Statement

The buy-phase fallback (`Receive.tsx` `handleGenerateInvoice` catch) triggers on
*any* rejection of `executeJitBuy` against the primary. The dominant failure is
the 30 s LSPS2 RPC timeout — but a timeout is ambiguous: the LSP may have
actually received `buyChannel` and begun reserving/opening a channel while the
client gave up and re-quoted the fallback. The user then receives over the
fallback (Megalith) channel while the primary (LQwD) may open an unsolicited,
never-to-be-paid channel.

Flagged by security-sentinel (P3). **Not a user-fund-loss path:** per the buy
flow (`context.tsx:335-371`), no payable primary invoice ever exists when the
primary buy rejects, so the payer cannot pay the primary and cannot double-pay.
The cost is LSP-side (orphaned reservation / spurious channel), so severity is
low — but it is a real surface worth documenting and optionally tightening.

## Findings

- **File**: `src/pages/Receive.tsx:459-470` (buy `.catch` → fallback);
  `src/ldk/lsps2/message-handler.ts:36,61-68` (30 s reaper = the ambiguous
  timeout source).
- Interacts with todo 368 (fallback latency): a shorter, pre-send-vs-post-send
  aware timeout would also reduce this ambiguity.

## Proposed Solutions

### Option A — Document as known cost (Smallest)
Add a code comment + note: buy-phase fallback may leave an orphaned primary
reservation/channel; this is LSP cost, not user funds.

### Option B — Classify the error before falling back (Medium)
Only auto-fall-back on errors classifiable as "request not acknowledged"
(connect failure / pre-send timeout). For a "response timeout after send,"
surface a manual retry instead, to avoid spawning a spurious primary channel.

### Option C — Detect + clean up a late primary channel-open (Medium/Large)
In the event handler, if the primary opens a channel for a JIT receive we
already serviced via the fallback, close/ignore it.

## Recommended Action

(Triage) Option A now; consider B/C if orphaned-channel telemetry shows it
happening in practice.

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`, `src/ldk/traits/event-handler.ts`
  (Option C), `src/ldk/lsps2/message-handler.ts` (Option B, with todo 368).

## Acceptance Criteria

- [ ] Behavior documented; OR fallback no longer fires on post-send response
      timeouts; OR late primary channel-opens are detected and handled.

## Work Log

- 2026-06-09 — Filed from `/ce:review` of PR #165.
- 2026-06-09 — **Resolved via Option A (document).** Added a comment at the
  buy-failure fallback site in `Receive.tsx` noting that a post-send buy timeout
  may leave an orphaned primary-side reservation — LSP cost, not user funds (no
  payable primary invoice ever exists). Options B/C (error classification / late
  channel-open cleanup) left as future work if telemetry shows it in practice.

## Resources

- PR #165; `todos/368-pending-p2-jit-buy-phase-fallback-latency.md`
