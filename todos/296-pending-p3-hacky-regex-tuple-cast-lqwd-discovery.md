---
status: pending
priority: p3
issue_id: 296
tags: [code-review, tooling, pr-148]
dependencies: []
---

# P3 — Hacky regex tuple cast in lqwd-discovery.ts

## Problem Statement

`lqwd-discovery.ts` casts `RegExpExecArray` to an intersection with a fixed-length tuple to bypass `noUncheckedIndexedAccess`. The intersection lies — `RegExpExecArray` is not structurally a tuple — and future readers will reach for the same pattern instead of using a real narrowing technique.

## Findings

- `src/ldk/lsp/lqwd-discovery.ts:48`:
  ```ts
  const [, nodeId, host, portStr] = match as RegExpExecArray & [string, string, string, string]
  ```
- The cast is purely a TypeScript silencer; runtime behavior depends on the `URI_RE.exec` contract, not the type.

## Proposed Solutions

### Option A — Named capture groups + undefined guard

Switch to `(?<nodeId>[0-9a-f]{66})@(?<host>[^:]+):(?<port>\d+)` and read from `match.groups`. Add an explicit `if (!groups || !groups.nodeId || !groups.host || !groups.port) throw` guard.

**Pros:** No casts; self-documenting; aligns with `noUncheckedIndexedAccess`.
**Cons:** Slightly more verbose; `match.groups` is `{[k:string]: string} | undefined`, still needs a check.
**Effort:** Small.
**Risk:** Low.

### Option B — Explicit destructure + post-condition guard

Keep the positional regex. Destructure into `string | undefined` triple and `if (!nodeId || !host || !portStr) throw new Error('regex matched but capture missing — should not happen')`.

**Pros:** Minimal diff; honest types.
**Cons:** Adds a "can't happen" branch; slightly more code.
**Effort:** Small.
**Risk:** Low.

## Recommended Action

Option A — named groups read better at the call site and document intent in the regex itself.

## Technical Details

- **Affected files:** `src/ldk/lsp/lqwd-discovery.ts`.

## Acceptance Criteria

- [ ] No `as` casts on `URI_RE.exec` result.
- [ ] All extracted captures are statically `string` (not `string | undefined`) at use sites.
- [ ] Tests / build / lint stay green.

## Work Log

| Date       | Action                                    | Notes                      |
| ---------- | ----------------------------------------- | -------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | kieran-typescript-reviewer |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/lsp/lqwd-discovery.ts:48`
