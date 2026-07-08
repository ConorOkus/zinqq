---
status: complete
priority: p2
issue_id: '387'
tags: [code-review, security, lsps2, validation, pr-168]
dependencies: []
---

# NaN from unparseable `valid_until` bypasses both freshness gates and flows into WASM/BOLT11

## Problem Statement

`Date.parse()` on a malformed `valid_until` returns `NaN`, and every NaN comparison is
false — so both freshness gates pass instead of failing. A malicious or buggy LSP response
defeats the exact validation PR #168 adds, issues the buy (LSP-side reservation) against an
invalid quote, and sends `NaN` across the JS→WASM boundary and into the BOLT11 encoder.
Found independently by security-sentinel and kieran-typescript-reviewer.

## Findings

- `computeJitInvoiceExpirySecs` (`src/ldk/context.tsx:370-377`): `headroomSecs` is NaN;
  `NaN < JIT_INVOICE_MIN_EXPIRY_SECS` → false → no throw; returns `Math.min(3600, NaN)` = NaN.
- Pre-existing Phase A gate has the same hole (`src/ldk/context.tsx:337`):
  `NaN < Date.now() + 30_000` → false → stale/garbage quote accepted.
- Root cause at the trust boundary: `deserializeOpeningFeeParams`
  (`src/ldk/lsps2/types.ts:182-199`) never validates that `valid_until` parses as a date.
- Downstream trace of `expirySecs = NaN`:
  1. Buy is issued before any throw — the "throw before reservation" guarantee is defeated.
  2. `create_inbound_payment(…, NaN, …)`: ToInt32(NaN) = 0 → payment registered already-expired.
  3. `intToWords(NaN)` (`src/ldk/lsps2/bolt11-encoder.ts:200-209`) returns `[]` →
     zero-length TAG_EXPIRY field (decoders read expiry 0 or reject).
  4. `expiresAtMs = NaN` passes the `=== null` guard in Receive; `setTimeout(fn, NaN)` fires
     immediately → QR flashes then flips to expired, masking the corrupt invoice.
- Impact: silent, hard-to-diagnose receive DoS from one bad LSP response. No funds at risk
  (no payable invoice ever exists).

## Proposed Solutions

### Option A: Fail-closed comparisons at both gates

Invert to `if (!(headroomSecs >= JIT_INVOICE_MIN_EXPIRY_SECS)) throw` in
`computeJitInvoiceExpirySecs`, and same inversion at the `:337` Phase A gate. NaN fails
`>=` and throws. Effort: Trivial. Risk: none.

### Option B: Validate at the trust boundary

In `deserializeOpeningFeeParams`:
`if (typeof raw.valid_until !== 'string' || !Number.isFinite(Date.parse(raw.valid_until))) throw` —
consistent with the bLIP-52 "client MUST fail on invalid opening_fee_params" posture already
applied to unknown keys. Effort: Small. Risk: none.

### Option C (recommended): Both A and B

Defense in depth: boundary rejection plus NaN-safe gates. Effort: Small.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`, `src/ldk/lsps2/types.ts`,
  `src/ldk/lsp/jit-failover.test.ts`, `src/ldk/lsps2/types.test.ts`.

## Acceptance Criteria

- [x] `computeJitInvoiceExpirySecs('garbage', now)` throws `JitQuoteFreshnessError` (unit test).
- [x] `deserializeOpeningFeeParams` rejects non-string / unparseable `valid_until` (unit test).
- [x] Phase A gate at `context.tsx:337` is NaN-safe.
- [x] Full suite + typecheck pass.

## Work Log

- 2026-07-08: Filed from `/ce:review` of PR #168 (security-sentinel + kieran-typescript-reviewer, converged independently).
- 2026-07-08: Fixed on the PR branch (Option C — both layers): explicit `Number.isFinite(Date.parse(...))` check in `computeJitInvoiceExpirySecs`, inverted Phase A comparison, boundary rejection in `deserializeOpeningFeeParams`. 3 new tests.
