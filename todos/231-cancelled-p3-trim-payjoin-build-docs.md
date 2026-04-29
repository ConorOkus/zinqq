---
status: cancelled
priority: p3
issue_id: '231'
tags: [code-review, payjoin, documentation, simplicity]
dependencies: []
---

# Trim `docs/payjoin-build.md` — defer the bump procedure

## Problem Statement

`docs/payjoin-build.md` is ~50 lines for what is currently a single-command workflow (`pnpm payjoin:build`). The "Bumping the submodule" section (lines 28-42) describes a procedure we haven't executed yet — it's speculative until the first real bump happens.

## Findings

- `docs/payjoin-build.md:28-42` — written without having performed a real submodule bump.
- The prerequisites table, one-time setup, and troubleshooting sections (lines 5-27, 44-50) are load-bearing.

Flagged by `code-simplicity-reviewer` (P3).

## Proposed Solution

Delete the "Bumping the submodule" section for now. When the first real bump happens (likely in Phase 3 or when following up on finding #223), document the actual steps from lived experience rather than ahead of time.

Keep: prereqs table, one-time setup, troubleshooting.

- Effort: Small.
- Risk: None.

## Technical Details

- Affected file: `docs/payjoin-build.md:28-42`

## Acceptance Criteria

- [ ] Bump section removed
- [ ] Rest of doc still coheres

## Work Log

## Resources

- PR #140

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
