---
status: pending
priority: p3
issue_id: '390'
tags: [code-review, lsps2, invoice, time, pr-168]
dependencies: []
---

# One deadline, three clock anchors: flight margin silently erodes by the buy round-trip

## Problem Statement

`expirySecs`/`expiresAtMs` are anchored to a *pre-buy* `Date.now()`, but the BOLT11
timestamp defaults to a *post-buy* `Date.now()` (after the `selectOpeningParams` RPC), and
`create_inbound_payment` anchors LDK's expiry to a third instant. The payer-visible encoded
expiry can outlive `valid_until − 30s` by up to ~15s (the RPC timeout), eating half the
flight margin. The invariant "JIT_INVOICE_FLIGHT_MARGIN_SECS (30) > REQUEST_TIMEOUT_MS
(15s)" holds only by cross-file coincidence — nothing documents or enforces it.

## Findings

- Anchors: `src/ldk/context.tsx:401-402` (two back-to-back `Date.now()` calls — should be
  one `nowMs` regardless), `create_inbound_payment` at `:436`, encoder default timestamp at
  `src/ldk/lsps2/bolt11-encoder.ts:56`.
- RPC bound: `REQUEST_TIMEOUT_MS = 15_000` (`src/ldk/lsps2/message-handler.ts:46`).
- Drift direction is benign for the UI (timer fires before encoded expiry) but erodes the
  LSP-side margin for the payer.
- Related (security-sentinel, informational): the whole clamp trusts the client clock vs the
  LSP's absolute `valid_until`; a slow client clock re-opens the original bug for the skew
  window. Possible mitigations if ever needed: bound skew via the `Date` header on the
  same-origin proxy response, or cap by elapsed-time-since-quote-fetch (relative,
  skew-immune).

## Proposed Solutions

### Option A (recommended): Single deadline owner

Compute `deadlineMs = Date.parse(validUntil) − FLIGHT_MARGIN_MS` once at buy entry; after
the buy returns, derive `expirySecs = floor((deadlineMs − Date.now())/1000)` and pass the
encoder's explicit `timestamp` param; set `expiresAtMs = deadlineMs`. One owner of time,
zero erosion, kills the cross-file invariant. Effort: Small. Risk: low (re-check the
min-expiry throw still happens pre-buy).

### Option B: Document the invariant only

Comment on `JIT_INVOICE_FLIGHT_MARGIN_SECS` that it must exceed `REQUEST_TIMEOUT_MS`, and
hoist the duplicate `Date.now()`. Effort: Trivial. Risk: invariant can still rot silently.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`, `src/ldk/lsps2/bolt11-encoder.ts` (explicit
  timestamp param already exists), `src/ldk/lsp/jit-failover.test.ts`.

## Acceptance Criteria

- [ ] All three expiries (BOLT11, LDK pending payment, UI `expiresAtMs`) derive from one
      deadline computed once from `valid_until`.
- [ ] No standalone `Date.now()` pairs for the same instant.
- [ ] Unit tests updated for the post-buy derivation.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (kieran-typescript-reviewer +
  architecture-strategist, same root; security-sentinel clock-skew note folded in).
