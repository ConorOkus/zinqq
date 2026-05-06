---
status: pending
priority: p3
issue_id: 303
tags: [code-review, architecture, pr-148]
dependencies: []
---

# P3 — CSP duplicated in vercel.json + index.html (drift risk)

## Problem Statement

CSP `connect-src` lists exist in both `vercel.json` (response header) and `index.html` (`<meta http-equiv>`). Both got widened with `https://germany.lqwd.tech` in this PR. The directives have already drifted in pre-existing ways: `vercel.json` has `font-src/frame-src/manifest-src/frame-ancestors/form-action` directives that `index.html` doesn't. A single source of truth would prevent quietly-different policies in dev (meta) vs production (header).

## Findings

- `vercel.json:31` — full CSP including `germany.lqwd.tech`.
- `index.html:13` — separate CSP including `germany.lqwd.tech` but missing several directives present in `vercel.json`.
- Pre-existing drift not introduced by this PR; PR did the hard part of remembering to update both, but the structural problem remains.

## Proposed Solutions

### Option A — Single `csp.ts` constant, generate both

Define directives in TS, use a build-time codegen step (or vite plugin) to emit the meta tag and a Vercel header config. One change, two outputs.

**Pros:** Eliminates drift entirely.
**Cons:** Build-time machinery; needs care with vercel.json which is mostly static JSON.
**Effort:** Medium.
**Risk:** Low.

### Option B — Cross-reference comment + manual sync

Add a comment in both files: "MUST stay in sync with the other; see CSP-SYNC.md". Code review catches drift.

**Pros:** Trivial.
**Cons:** Relies on humans; drift is the current state.
**Effort:** Trivial.
**Risk:** Medium — humans miss things.

### Option C — Drop the meta tag

Rely on the Vercel response header alone. The meta tag is a dev/preview convenience; can be replaced by a vite middleware that injects the same CSP in dev.

**Pros:** One source of truth; simplest mental model.
**Cons:** Loses CSP coverage for any static-file dev server that doesn't run Vercel/vite middleware.
**Effort:** Small to Medium.
**Risk:** Low if dev workflow stays on vite.

## Recommended Action

Option C is the cleanest if dev only ever runs through vite (which we do). Option B is the cheap stopgap.

## Technical Details

- **Affected files:** `vercel.json`, `index.html`, possibly a new `csp.ts` or vite middleware.

## Acceptance Criteria

- [ ] Either single source of truth, or explicit cross-reference comment in both files.
- [ ] Existing CSP behaviour preserved in production (Vercel header).
- [ ] Tests / build / lint stay green.

## Work Log

| Date       | Action                                    | Notes                   |
| ---------- | ----------------------------------------- | ----------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | architecture-strategist |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `vercel.json:31`, `index.html:13`
