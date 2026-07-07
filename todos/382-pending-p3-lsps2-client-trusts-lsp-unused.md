---
status: pending
priority: p3
issue_id: '382'
tags: [code-review, lsps2, blip-52, pr-167]
dependencies: []
---

# `LSPS2InvoiceParameters.clientTrustsLsp` is parsed but never consumed

## Problem Statement

`clientTrustsLsp` is deserialized (`src/ldk/lsps2/client.ts:83,95`) and typed
(`src/ldk/lsps2/types.ts:45`) but read nowhere (grep-confirmed). It predates PR #167 (it was
on the old `BuyResponse`), but the rename to the "LDK-parity" type `LSPS2InvoiceParameters`
is a natural moment to resolve it. In bLIP-52 the client-trusts-LSP vs LSP-trusts-client
model affects the pay-before-open flow; the wallet currently ignores it. Carrying an unused
protocol field into a type whose purpose is faithful parity slightly undercuts the story.

Raised by the TypeScript reviewer (P3) and architecture-strategist (Low, pre-existing #5).

## Findings

- Field is set from `result.client_trusts_lsp` and never referenced by the accept/trust or
  buy logic.

## Proposed Solutions

### Option A: Document intentional non-use

Add a one-line comment on the field explaining the wallet only supports the
client-trusts-LSP flow (or whichever assumption holds) and ignores this signal. Effort:
Trivial.

### Option B: Wire it into the flow

Consult `clientTrustsLsp` where the JIT trust/accept decision is made. Effort: Medium;
needs a clear behavioral spec — defer unless there's a concrete need.

## Recommended Action

(Triage) Option A now; Option B only if a real requirement emerges.

## Technical Details

- **Affected files**: `src/ldk/lsps2/types.ts`, `src/ldk/lsps2/client.ts`.

## Acceptance Criteria

- [ ] `clientTrustsLsp` is either consumed or documented as intentionally ignored.

## Work Log

- 2026-07-07: Filed from `/ce:review` of PR #167.
