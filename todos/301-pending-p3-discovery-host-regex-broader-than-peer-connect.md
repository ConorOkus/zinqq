---
status: pending
priority: p3
issue_id: 301
tags: [code-review, security, pr-148]
dependencies: []
---

# P3 — Discovery host regex broader than peer-connect regex

## Problem Statement

`lqwd-discovery.ts` accepts any non-colon char in the host segment of `uris[0]`, while `peer-connection.ts` requires `[a-zA-Z0-9._-]+`. Net safe (peer-connect rejects malformed hosts at connect time), but tightening the discovery regex would fail at the trust boundary with clearer telemetry. Defense in depth.

## Findings

- `src/ldk/lsp/lqwd-discovery.ts:21`:
  ```ts
  const URI_RE = /^([0-9a-f]{66})@([^:]+):(\d+)$/
  ```
- `src/ldk/peers/peer-connection.ts:28`:
  ```ts
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
    return Promise.reject(new Error('Invalid host: ...'))
  }
  ```
- The discovery regex's `[^:]+` accepts URL-unsafe and shell-meaningful characters; they get stripped/rejected later, but the failure surface is "WebSocket connect rejected" instead of "discovery rejected at the source".

## Proposed Solutions

### Option A — Tighten discovery regex to match peer-connect

Use `([a-zA-Z0-9._-]+)` for the host capture in `URI_RE`. Bracketed IPv6 (`[::1]`) is not currently supported by peer-connect anyway, so no regression.

**Pros:** Single source of truth; rejects malformed hosts at LSP boundary; clearer error message.
**Cons:** Mild duplication of regex constants.
**Effort:** Small.
**Risk:** Low — peer-connect already enforces this; no current LSP host fails it.

### Option B — Keep loose discovery, rely on peer-connect

Document that `URI_RE` is permissive on purpose because peer-connect handles host validation.

**Pros:** No code change.
**Cons:** No defense in depth; telemetry attributes the failure to the wrong stage.
**Effort:** Trivial.
**Risk:** Low.

## Recommended Action

Option A. Cheap defense in depth and the failure attribution is more useful in telemetry.

## Technical Details

- **Affected files:** `src/ldk/lsp/lqwd-discovery.ts`.

## Acceptance Criteria

- [ ] `URI_RE` host capture restricted to `[a-zA-Z0-9._-]+`.
- [ ] Existing LQwD `germany.lqwd.tech` host still passes.
- [ ] Tests / build / lint stay green.

## Work Log

| Date       | Action                                    | Notes             |
| ---------- | ----------------------------------------- | ----------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | security-sentinel |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/lsp/lqwd-discovery.ts:21`, `src/ldk/peers/peer-connection.ts:28`
