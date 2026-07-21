---
status: pending
priority: p2
issue_id: '403'
tags: [code-review, close-records, type-safety, security, pr-172]
dependencies: []
---

# `deserializeCloseRecord` casts `role` unvalidated and accepts arbitrary `txid` strings

## Problem Statement

`close-record.ts:190` does `t.role as CloseTxRole`, admitting any persisted string (e.g.
from a newer schema on another device) into the union — `ROLE_LABELS[tx.role]` then renders
`undefined` (silent blank label) and the type lies. `txid` accepts any string; downstream
is safe (fixed-origin explorer URL, React escaping), but a VSS-injected record whose txid
equals one of the user's real on-chain txids would hide that transaction from Activity via
the absorption set and replace it with attacker-chosen amounts. Exploitation requires the
user's VSS encryption key (server can't — AEAD), so this is defense-in-depth — but the
tolerant-decode design validates everything else; these two fields should match.

## Findings

- kieran-typescript-reviewer Important #4 + security-sentinel LOW-MEDIUM #4 (converged).
- Validation sets already exist implicitly: `CloseTxRole` union, 64-hex txid format.

## Proposed Solutions

### Option A: Validate both at decode

`role` against a `Set<CloseTxRole>` (unknown → drop the tx entry or default with an
explicit `'unknown'` label); `txid` against `/^[0-9a-f]{64}$/` (reject entry otherwise).
Effort: Small. Risk: none — invalid entries were never writable by this app.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/ldk/close-records/close-record.ts`, `close-record.test.ts`,
  `src/pages/ChannelCloseDetail.tsx` (label fallback if defaulting).

## Acceptance Criteria

- [ ] Garbage role/txid from a decoded blob cannot enter the in-memory record set
- [ ] Round-trip tests updated with invalid-field fixtures

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (two agents converged).
