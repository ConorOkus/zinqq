---
status: cancelled
priority: p3
issue_id: '248'
tags: [code-review, payjoin, simplicity, docs]
dependencies: []
---

# Trim `build-payjoin-bindings.sh` header rationale into docs

## Problem Statement

The header of `scripts/build-payjoin-bindings.sh` (lines 4-14) is ~10 lines explaining:

1. Where this script is invoked from (CI, Vercel, pnpm) — load-bearing for greppability.
2. Why we deliberately diverge from `generate_bindings.sh` (skip `build:test-utils`).

Item 2 is "rationale" — useful to a future maintainer but not load-bearing in the script's own logic. It belongs in `docs/payjoin-build.md` or a `docs/solutions/` note.

## Findings

- `scripts/build-payjoin-bindings.sh:4-14` — header comments.

Flagged by `code-simplicity-reviewer` (P3).

## Proposed Solution

Replace lines 10-14 with a one-liner:

```sh
# Skips upstream's build:test-utils (napi-rs helper, unused; runs unreviewed
# lifecycle scripts). See docs/payjoin-build.md for full rationale.
```

Move the longer prose into `docs/payjoin-build.md` under a "Why a custom build recipe?" section.

- Effort: Small.
- Risk: None.

## Technical Details

- Affected files: `scripts/build-payjoin-bindings.sh`, `docs/payjoin-build.md`

## Acceptance Criteria

- [ ] Build script header trimmed; rationale linked
- [ ] `docs/payjoin-build.md` carries the full divergence explanation

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
