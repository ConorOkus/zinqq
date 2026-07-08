---
status: pending
priority: p3
issue_id: '395'
tags: [code-review, lsps2, architecture, docs, pr-168]
dependencies: []
---

# `JitInvoiceResult` placement deepens a layering mismatch; context-surface JSDoc not updated

## Problem Statement

Two small contract-surface issues from PR #168. (1) `expiresAtMs` is pure wallet policy
(`valid_until` minus a wallet-chosen margin — no protocol counterpart), which makes
`JitInvoiceResult`'s home in `src/ldk/lsps2/types.ts` ("protocol types and serialization
helpers") the moment the type stopped being plausibly protocol-shaped; its Phase A analogue
`JitQuote` already lives in `context.tsx`. (2) The `executeJitBuy` JSDoc on
`LdkContextValue` — the surface a programmatic caller reads — doesn't mention the new
pre-reservation `JitQuoteFreshnessError` throw or that `expiresAtMs` is the invoice's real
payability deadline (LSP fails HTLCs after it regardless of BOLT11 expiry).

## Findings

- `JitInvoiceResult` at `src/ldk/lsps2/types.ts:48-58`; `JitQuote` at
  `src/ldk/context.tsx:146` (architecture-strategist).
- Stale JSDoc at `src/ldk/ldk-context.ts:60-70` (agent-native-reviewer; implementation-side
  docs in `context.tsx`/`types.ts` are already good).

## Proposed Solutions

### Option A (recommended): Move + document

Move `JitInvoiceResult` beside `JitQuote` in `context.tsx` (update the `ldk-context.ts`
import); add one caller-facing sentence to the `executeJitBuy` JSDoc covering the freshness
throw and `expiresAtMs` semantics. Effort: Trivial (mechanical). Risk: none.

## Recommended Action

(Triage) Good bundling candidate with todo 381 (naming-parity sweep touches the same files).

## Technical Details

- **Affected files**: `src/ldk/lsps2/types.ts`, `src/ldk/context.tsx`,
  `src/ldk/ldk-context.ts`.

## Acceptance Criteria

- [ ] `JitInvoiceResult` lives with the app-layer invoice types.
- [ ] `LdkContextValue.executeJitBuy` JSDoc mentions `JitQuoteFreshnessError` (pre-reservation)
      and `expiresAtMs` semantics.
- [ ] Typecheck passes.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (architecture-strategist +
  agent-native-reviewer, merged).
