---
status: cancelled
priority: p2
issue_id: '246'
tags: [code-review, payjoin, security, supply-chain, ci]
dependencies: []
---

# Cache integrity check on the cached `wasm-bindgen` binary

## Problem Statement

`.github/workflows/ci.yml:35-39` caches `~/.cargo/bin/wasm-bindgen` keyed only on `wasm-bindgen-cli-0.2.108`. The script's runtime check (`scripts/build-payjoin-bindings.sh:25-28`) verifies presence and version-string match — but a poisoned binary that prints the right `--version` passes both checks.

`actions/cache@v4` is scoped per-repo with branch fallback semantics — a PR cannot poison main's cache, but a prior compromised commit on main could persist a binary indefinitely.

This is defence-in-depth — the practical risk today is low (no prior compromise has occurred) but the gap means any single bad commit on main becomes long-lived.

## Findings

- `scripts/build-payjoin-bindings.sh:25-28` — version check is spoofable.
- `.github/workflows/ci.yml:38-39` — cache key has no integrity component.

Flagged by `security-sentinel` (P2).

## Proposed Solutions

### Option 1 — Hash the cached binary

After cache restore, verify SHA-256 of `~/.cargo/bin/wasm-bindgen` against a pinned hash:

```yaml
- name: Verify wasm-bindgen integrity
  if: hashFiles('~/.cargo/bin/wasm-bindgen') != ''
  run: |
    EXPECTED="<sha256-of-0.2.108-binary-on-linux-x86_64>"
    ACTUAL=$(sha256sum ~/.cargo/bin/wasm-bindgen | awk '{print $1}')
    [ "$ACTUAL" = "$EXPECTED" ] || rm ~/.cargo/bin/wasm-bindgen
```

If the hash doesn't match, the binary is removed and the script's `cargo install` rebuilds from source. The pinned hash is committed alongside `WASM_BINDGEN_VERSION` (see todo #245).

- Pros: Catches cache poisoning; binary integrity verified before use.
- Cons: Hash differs across host architectures and slight build determinism issues; one more value to bump on version changes.
- Effort: Small.
- Risk: Low.

### Option 2 — Drop the binary cache entirely

`cargo install wasm-bindgen-cli --locked` from source on every cache miss. The dist cache (which includes the wasm output) is the actually-load-bearing one; the binary-bin cache shaves ~2 min off cold builds, which is below the noise floor.

- Pros: Eliminates the threat model entirely.
- Cons: Adds 2-3 min per cold CI run; doesn't help Vercel (no GHA cache).
- Effort: Trivial (delete the cache step).
- Risk: None.

### Option 3 — Accept the risk

Trust the existing `--locked` install path; rely on actions/cache's branch isolation as sufficient defence.

- Pros: No work.
- Cons: Defence-in-depth gap remains.
- Effort: None.
- Risk: Medium.

## Recommended Action

Option 2. The cache savings are not material relative to the integrity gap; the dist cache (which dominates cold-build time) is unaffected.

## Technical Details

- Affected file: `.github/workflows/ci.yml` (delete the `Cache cargo bin` step)

## Acceptance Criteria

- [ ] Either: integrity check on cached binary present and verified, OR cache step removed
- [ ] CI cold build time on first PR run within acceptable range (<10 min)

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
