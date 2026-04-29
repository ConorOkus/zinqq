---
status: cancelled
priority: p2
issue_id: '244'
tags: [code-review, payjoin, ci, supply-chain, maintenance]
dependencies: []
---

# Detect drift between `scripts/build-payjoin-bindings.sh` and upstream's `generate_bindings.sh`

## Problem Statement

Our `scripts/build-payjoin-bindings.sh` is a deliberate fork of upstream's `vendor/rust-payjoin/payjoin-ffi/javascript/scripts/generate_bindings.sh`. We replicate the recipe minus `build:test-utils` and add belt-and-suspenders flags. But nothing detects when upstream changes the recipe — adds a new step, bumps the cargo-add MSRV pin, etc.

When upstream drifts, our copy silently goes stale. The failure mode is a CI break weeks later, not a diff at submodule-bump time.

## Findings

- `scripts/build-payjoin-bindings.sh:50` cites upstream `generate_bindings.sh:18-20` as the source of the MSRV cargo-add hack. If upstream renames the dep, bumps the version, or removes the hack entirely, our script keeps doing the wrong thing.
- The current submodule pin (`e22e3724`) was a snapshot of master HEAD at the time of vendoring; subsequent submodule bumps will quietly carry a new `generate_bindings.sh` we never reviewed.
- Flagged by `architecture-strategist` (P1, downgraded to P2 here — maintenance concern, not a security bug; build will fail loudly if drift produces an actual incompatibility).

## Proposed Solutions

### Option 1 — Hash pin + scheduled drift check (recommended)

Add a header comment in `build-payjoin-bindings.sh`:

```sh
# UPSTREAM_GENERATE_BINDINGS_SHA256=<sha256 of upstream's script at last review>
```

CI workflow `payjoin-drift.yml` runs on a `schedule:` (weekly) and on submodule bumps:

```yaml
- name: Check upstream drift
  run: |
    UPSTREAM_HASH=$(sha256sum vendor/rust-payjoin/payjoin-ffi/javascript/scripts/generate_bindings.sh | awk '{print $1}')
    PINNED_HASH=$(grep '^# UPSTREAM_GENERATE_BINDINGS_SHA256=' scripts/build-payjoin-bindings.sh | cut -d= -f2)
    [ "$UPSTREAM_HASH" = "$PINNED_HASH" ] || exit 1
```

When upstream changes, the check fails, an engineer reviews the diff, and updates the pin.

- Pros: forces explicit human review at the moment drift matters; cheap.
- Cons: one more file to remember to update on submodule bumps.
- Effort: Small.
- Risk: Low.

### Option 2 — Vendor `generate_bindings.sh` directly under `scripts/upstream-generate-bindings.sh`

Copy the upstream script into our tree alongside our customised one. Diff them in CI on every PR. Same intent as Option 1 but the diff is on full content not just hashes — easier to read in review.

- Pros: Reviewers see the actual diff in PR comments.
- Cons: Doubles the maintenance footprint; encourages copy-paste over abstraction.
- Effort: Small.
- Risk: Low.

### Option 3 — Accept the drift risk

Submodule bumps are infrequent and reviewed PRs. A bump that introduces a recipe change will probably break the build cleanly. Drift is theoretical until it bites.

- Pros: Zero new infra.
- Cons: We've explicitly forked upstream's behaviour; without a guard the fork rots.
- Effort: None.
- Risk: Medium.

## Recommended Action

Option 1. Cheap and forces the right human checkpoint. Land alongside todo #223 (release-tag pin) work — both are "what does a submodule bump need to verify" concerns.

## Technical Details

- Affected files: `scripts/build-payjoin-bindings.sh`, new `.github/workflows/payjoin-drift.yml`

## Acceptance Criteria

- [ ] `UPSTREAM_GENERATE_BINDINGS_SHA256=` pin in script header
- [ ] Scheduled drift-check job exists
- [ ] Drift-check fails when upstream's script content changes; passes after pin update

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
