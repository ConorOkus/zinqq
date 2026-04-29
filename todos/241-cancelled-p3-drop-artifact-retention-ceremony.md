---
status: cancelled
priority: p3
issue_id: '241'
tags: [code-review, payjoin, ci, simplicity]
dependencies: []
---

# Drop `retention-days: 1` on the Payjoin dist artifact

## Problem Statement

`ci.yml:75` sets `retention-days: 1` on the Payjoin dist artifact. GitHub's default is 90 days, but the artifact is consumed in the same workflow run by the `check` job — minutes later. Setting a 1-day retention saves nothing meaningful and adds a line of ceremony.

If storage is a real concern, it should be a repo-level setting, not per-artifact.

## Findings

- `.github/workflows/ci.yml:75` — `retention-days: 1`

Flagged by `code-simplicity-reviewer` (P3).

## Proposed Solution

Remove the line.

- Effort: Trivial.
- Risk: None.

## Technical Details

- Affected file: `.github/workflows/ci.yml`

## Acceptance Criteria

- [ ] `retention-days` line removed
- [ ] Artifact still uploads/downloads correctly

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
