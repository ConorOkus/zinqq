---
status: complete
priority: p2
issue_id: '235'
tags: [code-review, payjoin, security, ci]
dependencies: []
---

# Add `permissions: { contents: read }` to the `check` job

## Problem Statement

`payjoin-build` correctly declares `permissions: {}` so its steps run without any `GITHUB_TOKEN` scope. The `check` job (`.github/workflows/ci.yml:77-81`) has no explicit `permissions:` block and therefore inherits whatever the repo default is — which for most GitHub accounts is `write-all` at the workflow level.

Given `check` runs `pnpm install`, `pnpm build`, and proxy install/test against untrusted PR code and downloaded artefacts, a single compromised transitive dep with access to the default token can post PR comments, write releases, or push artefacts.

## Findings

- `.github/workflows/ci.yml:77-81` — `check` job has no `permissions:` declaration.
- `.github/workflows/ci.yml:15-17` — `payjoin-build` correctly sets `permissions: {}`.

Flagged by `security-sentinel` (P2).

## Proposed Solution

Add an explicit read-only permissions block:

```yaml
check:
  needs: payjoin-build
  runs-on: ubuntu-latest
  timeout-minutes: 15
  permissions:
    contents: read
  steps:
    ...
```

`contents: read` is what checkout needs; everything else is implicitly denied.

- Effort: Small.
- Risk: None.

## Technical Details

- Affected file: `.github/workflows/ci.yml`

## Acceptance Criteria

- [ ] `check` job has explicit `permissions: { contents: read }`
- [ ] CI still passes (no step relied on implicit write scopes)

## Work Log

## Resources

- PR #141
