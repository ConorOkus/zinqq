---
status: pending
priority: p2
issue_id: '380'
tags: [code-review, lsps2, jit-receive, channel-config, maintainability, pr-167]
dependencies: []
---

# JIT channel settings duplicated as raw literals in two modules (drift risk)

## Problem Statement

PR #167 added `buildJitChannelConfigOverrides` (`src/ldk/traits/event-handler.ts`), which
hardcodes `accept_underpaying_htlcs = true` and
`max_inbound_htlc_value_in_flight_percent_of_channel = 100`. These are the exact two values
already set wallet-globally in `src/ldk/user-config.ts:41` and `:26`. There is no shared
constant — the literals live in two modules linked only by a prose comment ("mirror the
wallet-global settings... retained as the safety net").

The comment frames the duplication as intentional defense-in-depth (pinning per-channel via
the LDK 0.2 `config_overrides` slot is a sound pattern). The problem is the invariant
"per-channel override == global default" is unenforced. A maintainer who later changes
`user-config.ts` (e.g. to gate underpayment acceptance) will silently leave the JIT override
pinned to the old value, and the "safety net" becomes a trap that reintroduces the exact
behavior they tried to remove. Raised by architecture-strategist (Medium #2).

## Findings

- Duplicated literals: `user-config.ts:26` / `:41` vs `event-handler.ts`
  `buildJitChannelConfigOverrides`.
- No test binds the two together, so drift is invisible until it manifests as a JIT-receive
  regression in production.
- Related (security, Low/informational): the override is applied to *every* trusted-LSP
  0-conf channel (`event-handler.ts` accept branch), not only JIT-receive channels. Same
  values as global, so no posture change today, but the helper name implies "JIT only."
  Worth a clarifying comment when touching this code.

## Proposed Solutions

### Option A: Extract shared named constants
Define e.g. `JIT_ACCEPT_UNDERPAYING_HTLCS = true` and `JIT_MAX_INBOUND_INFLIGHT_PCT = 100`
in one module (e.g. `user-config.ts` or a small `ldk/jit-config.ts`) and consume from both
`user-config.ts` and `event-handler.ts`. Pros: makes the mirror structural, not documentary.
Cons: one new import each side. Effort: Small.

### Option B: Leave as-is with a stronger cross-reference comment
Pros: zero code change. Cons: doesn't prevent drift; relies on future maintainers reading
both comments. Effort: Trivial. Not recommended.

## Recommended Action

(Triage) Option A — small, and it removes the one latent failure mode this PR introduced
that could silently break JIT receive long after merge.

## Technical Details

- **Affected files**: `src/ldk/user-config.ts`, `src/ldk/traits/event-handler.ts`.

## Acceptance Criteria

- [ ] The two JIT channel settings have a single source of truth consumed by both the
      global config and the per-channel override.
- [ ] `pnpm typecheck` + full suite pass; event-handler override test still asserts the
      pinned values.

## Work Log

- 2026-07-07: Filed from `/ce:review` of PR #167.
