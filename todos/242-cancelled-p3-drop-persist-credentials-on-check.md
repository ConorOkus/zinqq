---
status: cancelled
priority: p3
issue_id: '242'
tags: [code-review, payjoin, ci, simplicity]
dependencies: []
---

# Drop `persist-credentials: false` on the `check` job

## Problem Statement

`ci.yml:85` sets `persist-credentials: false` on the `check` job's checkout. The flag is only load-bearing when subsequent steps would otherwise use the persisted token for pushes/fetches against the repo. `check` runs `pnpm install`, typecheck, lint, test, build, proxy install — none of which hit git.

The flag **is** meaningful on `payjoin-build` (line 22) because that job fetches recursive submodules and could carry credentials into `generate_bindings.sh`'s transitive npm/cargo invocations.

## Findings

- `.github/workflows/ci.yml:85` — `persist-credentials: false` on check job.
- No git-writing step follows.

Flagged by `code-simplicity-reviewer` (P2). Rated P3 here because defensive hygiene has some value even when not strictly needed.

## Proposed Solutions

### Option 1 — Drop the flag on `check`

Smaller diff, reduces noise.

### Option 2 — Keep both as defensive defaults

Argument: pasted `actions/checkout@v4` with `persist-credentials: false` as a project convention is worth the one line of ceremony.

Either reading is defensible. The decision belongs to the PR reviewer's taste; no correctness implication.

## Recommended Action

Drop on `check`. The `payjoin-build` annotation remains meaningful and serves as a useful beacon for where the flag actually matters.

## Technical Details

- Affected file: `.github/workflows/ci.yml`

## Acceptance Criteria

- [ ] Line 85 removed
- [ ] CI still green

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
