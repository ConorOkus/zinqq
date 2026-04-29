---
status: cancelled
priority: p2
issue_id: '226'
tags: [code-review, payjoin, security, supply-chain]
dependencies: []
---

# Commit SHA-256 manifest of built Payjoin artifacts

## Problem Statement

Nothing currently binds the built `dist/` artifacts to a reviewable known-good hash. A developer-machine compromise, a submodule force-push, or CI cache poisoning could silently swap the WASM that runs next to user seeds — the reviewer of a future PR bumping `vendor/rust-payjoin` has no mechanism to verify the resulting binary matches what the submodule SHA should produce.

The plan (`docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md:899-907`) explicitly calls for Sigstore attestation + hash manifests. This PR ships without that.

## Findings

- No hash manifest exists under `vendor/` or `src/onchain/payjoin/`.
- `.github/workflows/ci.yml:46-66` — builds and uses dist/ with no integrity check.
- `src/onchain/payjoin/payjoin.ts` — loads WASM at runtime with no explicit hash check (Vite fingerprints the filename but that's not the same as verifying the source artifact).

Flagged by `security-sentinel` (P2) and `architecture-strategist` (P2 — `link:` bypasses lockfile integrity).

## Proposed Solutions

### Option 1 — Committed manifest + CI gate

After each submodule bump, run `pnpm payjoin:build` locally and commit a `vendor/payjoin-manifest.sha256` listing every file under `dist/` with its sha256. CI rebuilds and diffs: drift → red build.

- Pros: Human-reviewable; catches any in-tree tampering or upstream force-push that changes the build output; small lockfile-like addition.
- Cons: Every submodule bump now has a required manifest-update step; contributors without the full toolchain can't regenerate locally.
- Effort: Medium.
- Risk: Low.

### Option 2 — GitHub Actions build-provenance attestation

Use `actions/attest-build-provenance@v1` on the `payjoin-build` job (see finding #225) to publish a Sigstore bundle per CI-built artifact. Verify at runtime is out of scope, but the provenance log becomes queryable and tamper-evident.

- Pros: Standard toolchain; no committed files.
- Cons: Only catches CI-side tampering, not developer-machine tampering; requires reviewer tooling to actually verify.
- Effort: Small.
- Risk: Low.

### Option 3 — Both

Attestation on the CI build **and** a committed manifest updated on each submodule bump. Belt + suspenders.

- Effort: Medium.
- Risk: Low.

## Recommended Action

Option 1 for the next PR. Add Option 2 when the Payjoin build is split into its own job (finding #225).

## Technical Details

- New file: `vendor/payjoin-manifest.sha256`
- CI step (added to `payjoin-build` job): `sha256sum -c vendor/payjoin-manifest.sha256` after build

## Acceptance Criteria

- [ ] Manifest file exists and is tracked
- [ ] CI fails if `dist/` contents don't match the manifest
- [ ] Bump procedure in `docs/payjoin-build.md` documents manifest regeneration

## Work Log

## Resources

- PR #140
- Plan section: `docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md:897-907`

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
