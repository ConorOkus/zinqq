---
status: complete
priority: p2
issue_id: '370'
tags: [code-review, architecture, lsps2, jit-receive, lsp-failover, agent-native, maintainability]
dependencies: []
---

# Buy-phase fallback hardcodes the `'lqwd'` primary label and lives in the UI layer

## Problem Statement

The buy-phase fallback added in PR #165 decides "was this the primary LSP, and
should I fall back?" with a hardcoded string literal in a React component:

```ts
// src/pages/Receive.tsx (handleGenerateInvoice catch)
if (quote.contact.label === 'lqwd' && !viaFallback) {
  reQuoteSkippingPrimary(amountSats)
  return
}
```

Three reviewers (kieran-typescript, architecture-strategist, agent-native)
independently flagged this as the top issue. It has three coupled problems:

1. **Topology leak / latent bug.** The authoritative primary/fallback mapping
   lives in `resolveLspContacts()` (`src/ldk/lsp/contacts.ts:31`), which assigns
   *slots*. The ordering already flipped once (Megalith→LQwD as primary in
   PR #148, per `reference_lqwd_lsp.md`). If it flips again, `runJitQuoteFlow`
   keeps working (it reasons about slots) but this UI check silently stops
   triggering fallback — no type error, no test failure.
2. **Redundant source of truth.** `viaFallback` and `quote.contact.label` encode
   the same fact twice; a `viaFallback: true` quote always has
   `label === 'megalith'`, so `!viaFallback` is dead under normal flow.
3. **Wrong layer / parity gap.** Phase A (quote) failover is a pure, testable,
   telemetried orchestrator in `context.tsx` (`runJitQuoteFlow`, `attempt`
   seam). The Phase B (buy) equivalent is scattered across a component
   `useCallback`, a `.catch`, and a `ReceiveState` flag — only drivable via the
   React UI, not by a programmatic/agent caller or a second surface.

## Findings

- **File**: `src/pages/Receive.tsx:466` (label check), `:404-435`
  (`reQuoteSkippingPrimary`), `:442,466` (`viaFallback`).
- **Reviewers**: kieran-typescript (P1), architecture-strategist (P1),
  agent-native (P2), code-simplicity (noted).
- Phase A failover pattern to mirror: `src/ldk/context.tsx:399-512`.

## Proposed Solutions

### Option A — Minimal: stop comparing the `'lqwd'` literal (Small)
Carry quote provenance on `JitQuote` — e.g. `role: 'primary' | 'fallback'` set
in `runJitQuoteFlow` where the quote is constructed — and branch on
`quote.role === 'primary'`. Drop `viaFallback` and render the disclosure banner
off `quote.role === 'fallback'`. Closes the demotion-breakage class and the
double-source-of-truth in one change. **Pros:** small, removes fragility now.
**Cons:** orchestration still in the UI.

### Option B — Full: hoist a `runJitBuyFlow` orchestrator into `context.tsx` (Medium/Large)
Mirror `runJitQuoteFlow`: a pure function that tries the buy against
`quote.contact`, and on failure — if that contact was the primary slot and a
distinct fallback exists — re-quotes+buys the fallback, returning the new quote
plus a `viaFallback` marker for the UI to disclose. The component calls one
function and renders the result (same shape as Phase A). "Is this the primary"
becomes contact-identity (`quote.contact.nodeId === contacts.primary?.nodeId`),
never a label. Moves telemetry into the layer that already owns failover
telemetry and makes it unit-testable + agent-drivable.
**Pros:** parity, testability, agent-native, kills the label leak. **Cons:**
larger; needs its own tests.

## Recommended Action

(Triage) Option A as the immediate fix; Option B as the proper direction —
consider pairing with todo 371 (shared helpers) and the ordered-contacts idea
below.

## Technical Details

- **Affected files**: `src/pages/Receive.tsx`, `src/ldk/context.tsx`,
  `src/ldk/ldk-context.ts`, `src/ldk/lsp/contacts.ts`.
- Related design-debt (architecture-strategist P2): `skipPrimary: boolean`
  expresses *position* not *intent*; an ordered `LspContact[]` candidate list
  would generalize to N LSPs and remove the synthetic `{primary:null, fallback}`
  reshape in `context.tsx:417-419`. Fold into Option B if pursued.

## Acceptance Criteria

- [ ] Buy-phase fallback no longer compares a hardcoded LSP label string.
- [ ] Single source of truth for "this quote is from the fallback" drives both
      the fallback guard and the disclosure banner.
- [ ] Behavior verified: primary buy failure → fallback re-quote → re-confirm;
      fallback buy failure → `jit-error` (no loop).
- [ ] (If Option B) buy-phase failover is unit-testable without React.

## Work Log

- 2026-06-09 — Filed from `/ce:review` of PR #165. Consensus finding (3 agents).
- 2026-06-09 — **Resolved via Option A.** Added `role?: 'primary' | 'fallback'`
  to `JitQuote`, stamped by `runJitQuoteFlow` (`context.tsx`) on both the primary
  and fallback returns. `Receive.tsx` now branches the buy-phase fallback on
  `quote.role === 'primary'` (was `quote.contact.label === 'lqwd'`) and renders
  the disclosure banner on `quote.role === 'fallback'`. Removed the redundant
  `viaFallback` state flag entirely — the quote is the single source of truth.
  Side benefit: a quote-time Phase-A failover now also shows the backup-provider
  disclosure (previously only buy-time fallback did). `jit-failover.test.ts`
  updated to assert the stamped role. **Option B (hoist a `runJitBuyFlow`
  orchestrator into `context.tsx` for full agent-native parity / non-React
  testability) was NOT done** — larger refactor; left as a possible future
  improvement. The acceptance-criteria item "buy-phase failover testable without
  React" remains open under that banner.

## Resources

- PR #165
- `reference_lqwd_lsp.md`, `reference_megalith_lsp.md` (primary/fallback flipped in PR #148)
- `docs/solutions/integration-issues/ldk-event-handler-multi-lsp-trust-set.md` (prior hardcoded-LSP-pubkey bug — same anti-pattern)
