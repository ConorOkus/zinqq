---
status: pending
priority: p2
issue_id: '236'
tags: [code-review, payjoin, security, ci, supply-chain]
dependencies: []
---

# Pin GitHub Actions by commit SHA with Dependabot

## Problem Statement

All GitHub Actions in `ci.yml` use mutable tag refs (`@v4`, `@v3`):

- `actions/checkout@v4` (x2)
- `pnpm/action-setup@v4`
- `actions/setup-node@v4`
- `actions/cache@v4` (x3)
- `actions/upload-artifact@v4`
- `actions/download-artifact@v4`

A maintainer takeover, tag rewrite, or npm-style takeover of any of these namespaces lets an attacker push arbitrary code into the action and have it run in every CI run. `permissions: {}` on `payjoin-build` caps the blast radius; but the `check` job and others still run with default token scope (see #235).

GitHub's recommended practice is to pin actions by commit SHA and use Dependabot to surface updates as PRs.

## Findings

- `.github/workflows/ci.yml:19, 22, 30, 41, 55, 71, 82, 87, 91, 97` — all actions use floating tags.
- No `.github/dependabot.yml` in the repo (verified).

Flagged by `security-sentinel` (P2).

## Proposed Solution

1. Pin each action to the commit SHA of its current release, with a comment preserving the human-readable tag:

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

2. Add `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

- Effort: Small.
- Risk: None.

## Technical Details

- Affected files: `.github/workflows/ci.yml`, new `.github/dependabot.yml`

## Acceptance Criteria

- [ ] All actions pinned by SHA with tag-comment suffix
- [ ] Dependabot configured for github-actions ecosystem
- [ ] First Dependabot PR lands cleanly

## Work Log

## Resources

- PR #141
- GitHub: https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
