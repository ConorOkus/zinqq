---
status: pending
priority: p3
issue_id: '408'
tags: [code-review, security, agent-native, close-records, pr-172]
dependencies: []
---

# Consider gating `window.__closeRecords.forceClose` — most destructive window primitive so far

## Problem Statement

Any page-context script (XSS, compromised dependency, malicious extension) can call
`window.__closeRecords.forceClose(id)` for every channel with zero user interaction:
unilateral close fees, funds timelocked for days, LSP relationship damage. `getAll()` also
hands full close history to any script. This follows the documented `__receive.commit`
precedent (agent-native convention: actions are exposed), and input handling is safe — but
force-close is the most destructive primitive on `window` so far, and the threat model
deserves an explicit decision rather than convention inheritance.

## Findings

- security-sentinel MEDIUM #2: `src/ldk/context.tsx:786-798, 1140-1148`. An XSS-level
  attacker already owns IDB/seed-adjacent surfaces, so this is hygiene/defense-in-depth,
  not a new boundary — but the blast radius of one call is larger than `__receive.commit`.

## Proposed Solutions

### Option A: Accept and document (status quo)

Record the threat-model decision in the agent-surface comment. Effort: Trivial.

### Option B: Per-session confirmation token

`forceClose(id, token)` where the token is printed to console on first call — one
deliberate extra step for scripts, trivial for agents. Effort: Small. Risk: slight agent
friction.

## Recommended Action

(Triage — owner call on threat model.)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`.

## Acceptance Criteria

- [ ] An explicit, recorded decision (code comment or docs) on why forceClose is or isn't
      gated

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (security-sentinel).
