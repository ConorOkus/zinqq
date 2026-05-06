---
status: pending
priority: p2
issue_id: 295
tags: [code-review, telemetry, refactor, pr-148]
dependencies: []
---

# P2 — Consolidate three `captureError` failover sites behind one helper

## Problem Statement

`runJitInvoiceFlow` in `src/ldk/context.tsx` has three `captureError` calls (lines ~131-152, ~158-167, ~176-186) that all log structurally similar JSON: `{trigger, primary, fallback, duration_ms, error?}`. Each builds the payload independently. The schema is the same; the calling sites just differ on which fields apply.

Consequence: if the schema changes (new field, renamed key, different severity rule), three places need updates and they can drift. The intent ("emit a structured failover event") is the same across all three.

## Findings

- **Three nearly-identical sites** in `src/ldk/context.tsx`:
  - `~138-141`: primary failed, no fallback (`error` severity, `{primary, trigger, error}`).
  - `~145-153`: primary failed, falling back (`warning` severity, `{trigger, primary, fallback, duration_ms}`).
  - `~158-167`: primary discovery failed, falling back (`warning` severity, `{trigger: 'http_preflight', fallback}`).
  - `~176-186`: both failed (`error` severity, `{fallback_trigger, duration_ms, error}`).

(That's actually four sites — the boundaries vary slightly between fallback-success and primary-discovery-fallback, but they share most fields.)

## Proposed Solutions

### Option A — One helper, three call sites

```ts
type FailoverEvent =
  | { kind: 'falling-back'; from: LspLabel; to: LspLabel; trigger: JitTrigger; duration_ms: number }
  | { kind: 'primary-only-failed'; from: LspLabel; trigger: JitTrigger; error: string }
  | { kind: 'both-failed'; trigger: JitTrigger; duration_ms: number; error: string }

function logFailover(ev: FailoverEvent): void {
  const severity =
    ev.kind === 'both-failed' || ev.kind === 'primary-only-failed' ? 'error' : 'warning'
  const message =
    /* short string per kind */
    captureError(severity, 'LSP', message, JSON.stringify(ev))
}
```

Call sites become single-line invocations.

**Pros:** Schema in one place. Discriminated union forces every emitter to declare which variant. Tests can assert on `JSON.parse(detail).kind`.

**Cons:** ~25 lines of new helper code; ~15 lines removed from call sites. Net diff negligible.

**Effort:** Small.

**Risk:** Very low — pure refactor.

### Option B — Status quo

**Pros:** No diff.

**Cons:** Schema drift possibility.

**Effort:** Zero.

**Risk:** Low.

## Recommended Action

(triage — depends on whether you expect more failover variants)

## Technical Details

- **Affected files:** `src/ldk/context.tsx` only.
- **Tests:** `src/ldk/lsp/jit-failover.test.ts` — should still pass; the test currently observes via `expect(...).toHaveBeenCalledTimes(...)` not by inspecting captureError directly. Could add an assertion on the structured `kind` field.

## Acceptance Criteria

- [ ] One helper function emits all failover events.
- [ ] All four call sites in `runJitInvoiceFlow` use the helper.
- [ ] Severity rules unchanged (warning for fallback-success, error for both-fail / primary-only-fail).
- [ ] Detail JSON shape preserved (existing search terms in PR description still match).
- [ ] All 21 LSP-failover tests still pass.

## Work Log

| Date       | Action                                    | Notes                             |
| ---------- | ----------------------------------------- | --------------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | code-simplicity-reviewer flagged. |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/context.tsx:131-186`
