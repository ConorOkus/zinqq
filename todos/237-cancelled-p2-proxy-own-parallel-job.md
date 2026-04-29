---
status: cancelled
priority: p2
issue_id: '237'
tags: [code-review, payjoin, ci, architecture]
dependencies: []
---

# Split proxy checks into their own parallel CI job

## Problem Statement

The proxy subproject (under `proxy/`) has zero dependency on the Payjoin WASM artefact but is currently nested inside the `check` job, which `needs: payjoin-build`. That means proxy typecheck/test sit behind ~7 min of Payjoin WASM compile on every cache-miss, and any transient Payjoin build failure masks unrelated proxy regressions.

## Findings

- `.github/workflows/ci.yml:120-130` — proxy install/typecheck/test steps.
- `.github/workflows/ci.yml:78` — `check` needs `payjoin-build`.
- Proxy code doesn't `import 'payjoin'` anywhere.

Flagged by `architecture-strategist` (P2).

## Proposed Solution

Extract a `proxy` job with no `needs:`:

```yaml
proxy:
  runs-on: ubuntu-latest
  timeout-minutes: 5
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@v4
      with:
        persist-credentials: false
    - uses: pnpm/action-setup@v4
      with:
        version: 10
    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: pnpm
    - run: pnpm install --frozen-lockfile
      working-directory: proxy
    - run: pnpm typecheck
      working-directory: proxy
    - run: pnpm test
      working-directory: proxy
```

And remove lines 120-130 from `check`.

Also consider the broader split the architecture reviewer suggested: `lint-test` (no needs, covers typecheck/lint/format/test) + `app-build` (needs: payjoin-build, covers `pnpm build`). That gives fast TS feedback on every push and reserves the slow path only for the step that actually needs the artefact.

- Effort: Small–Medium.
- Risk: Low.

## Recommended Action

Ship the proxy split first (trivial), then evaluate the full `lint-test` / `app-build` split once we have real CI timing data.

## Technical Details

- Affected file: `.github/workflows/ci.yml`

## Acceptance Criteria

- [ ] Proxy runs in its own job, parallel with payjoin-build
- [ ] Total CI critical path shortened for proxy-only changes

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
