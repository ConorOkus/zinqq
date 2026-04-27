---
status: complete
priority: p1
issue_id: '250'
tags: [code-review, payjoin, security, validator]
dependencies: []
---

# Validator's tx.version check is a silent no-op (and locktime is unchecked)

## Problem Statement

`proposal-validator.ts:42-47` reads `proposal.unsigned_tx.version` and `original.unsigned_tx.version` to assert version preservation. BDK's `Transaction` class (`bitcoindevkit.d.ts:770-862`) **does not expose `.version`** as a readonly field — only `is_lock_time_enabled`, `input`, `output`, etc. `Psbt.version` exists at line 672, but `Transaction.version` does not. At runtime `proposal.version` is `undefined` and `undefined !== undefined` is false — the check **never fires**.

The docstring (line 33) also claims "tx version + locktime preserved" but the function body has **no locktime comparison at all**.

## Findings

- **kieran-typescript-reviewer P1 #1**: BDK's `Transaction` doesn't have `.version`. The check passes typecheck only because the test fixtures (`proposal-validator.test.ts:fakePsbt`) synthesize `unsigned_tx.version` on hand-rolled fakes.
- **security-sentinel P1-1**: Confirms the silent no-op. A receiver setting tx version to v3 (TRUC, BIP 431) — different replacement and propagation semantics — would not be caught. BIP 78's "Sender's checklist" mandates version preservation.
- **security-sentinel P1-2**: Locktime claim in docstring is unsupported by code. A receiver could swap to a height-based locktime to delay the tx, neither fund loss nor caught.
- **architecture-strategist #9**: Same finding — locktime is missing.

## Proposed Solutions

### Option 1 (recommended) — Use Psbt-level fields, add locktime check

```ts
if (ctx.proposal.version !== ctx.original.version) {
  return { ok: false, reason: 'tx version changed' }
}
if (
  ctx.proposal.unsigned_tx.lock_time?.toString() !== ctx.original.unsigned_tx.lock_time?.toString()
) {
  return { ok: false, reason: 'locktime changed' }
}
```

Verify `Psbt.version` and `Transaction.lock_time` are actually exposed in BDK 0.3.0. If `lock_time` isn't, fall back to documenting the gap.

- Pros: Honors the docstring contract; fixes both holes; tests can use real Psbt instances or shape-typed fakes (`Pick<Psbt, 'version' | 'unsigned_tx' | 'fee'>`) so drift can't recur.
- Cons: Need to verify BDK API surface for `lock_time`.

### Option 2 — Drop the version check, correct the docstring

If the BDK API gap is too painful and PDK already handles version/locktime in its BIP 78 checklist, delete the version branch and update the comment to:

```
// version + locktime: relied on PDK BIP 78 check; not re-verified here
// (BDK TS bindings don't expose these at the Transaction level)
```

- Pros: Honest; no false sense of defense-in-depth.
- Cons: Removes a defense-in-depth check.

## Recommended Action

Option 1 with verification step. Run a quick `pnpm typecheck` against `ctx.proposal.version` and `ctx.original.unsigned_tx.lock_time` — if both compile, ship the full check. If only `version` compiles, ship just version + drop the locktime claim from the docstring.

## Technical Details

- Affected file: `src/onchain/payjoin/proposal-validator.ts` lines 32, 42-47
- Affected test: `src/onchain/payjoin/proposal-validator.test.ts` line 196 (the version-changed test currently passes against fake fixtures only)
- BDK API references: `node_modules/.pnpm/@bitcoindevkit+bdk-wallet-web@0.3.0/.../bitcoindevkit.d.ts:770-862` (Transaction), `:672` (Psbt.version)

## Acceptance Criteria

- [ ] Version check fires against a real (non-fake) Psbt-level field
- [ ] Locktime is either checked or the docstring is corrected
- [ ] Test fixture for "version changed" uses a shape that catches the runtime no-op (e.g., `Pick<Psbt, ...>`)
- [ ] No new lint/typecheck errors

## Work Log

**2026-04-26** — Resolved on PR #143 branch.

- BDK API verified: `Psbt.version` IS exposed (`bitcoindevkit.d.ts:672`); `Transaction.version` and `Transaction.lock_time` are NOT exposed. Only `Transaction.is_lock_time_enabled: boolean` is available for the locktime side.
- Switched the version check to `ctx.proposal.version !== ctx.original.version` (Psbt-level). Reason renamed to `'psbt version changed'` for accuracy.
- Added a coarse locktime check: `proposal.unsigned_tx.is_lock_time_enabled !== original.unsigned_tx.is_lock_time_enabled`. Reason `'locktime-enabled bit changed'`. Documented the BDK-API limitation in the doc comment (we can't compare the locktime _value_, only the enabled bit).
- Updated `fakePsbt` test fixture to put `version` at the Psbt level (matching real BDK shape) and added `is_lock_time_enabled` field to `unsigned_tx`. The shape mismatch was masking the production no-op.
- Added a new test exercising the locktime-bit check.
- Validator tests: 8 → 10 passing. Repo-wide: 457 → 459 passing.

## Resources

- PR #143
- Plan: `docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md`
- BIP 78 sender's checklist: https://github.com/bitcoin/bips/blob/master/bip-0078.mediawiki
