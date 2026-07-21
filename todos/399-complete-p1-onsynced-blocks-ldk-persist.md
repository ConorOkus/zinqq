---
status: complete
priority: p1
issue_id: '399'
tags: [code-review, chain-sync, performance, fund-safety, pr-172]
dependencies: []
---

# `onSynced` (reconciliation) is awaited before `schedulePersist` — Esplora outage can hold LDK persistence hostage

## Problem Statement

`src/ldk/sync/chain-sync.ts:239-245` awaits the `onSynced` hook after the sync abort budget
is cleared but BEFORE `await config.schedulePersist()`. Reconciliation can issue ~10
sequential Esplora requests, each with a 10s timeout, behind the shared 2-slot semaphore —
in an outage one tick can delay LDK ChannelManager persist scheduling and the next sync
pass by minutes. Feature work now gates the fund-critical persist path. Found independently
by architecture-strategist, kieran-typescript-reviewer, and security-sentinel.

## Findings

- The plan's network-discipline clause ("outside the sync abort budget") is honored in
  letter, not spirit.
- `reconcileInProgress` already prevents overlapping passes, so fire-and-forget is safe.
- No monitor-persistence risk (monitors persist via their own trait), but CM persist and
  tick cadence are delayed.

## Proposed Solutions

### Option A: Move the await after `schedulePersist()` (one-line reorder)

Keeps "don't overlap next tick" politeness, removes the persist delay. Effort: Trivial.
Risk: none.

### Option B: Fire-and-forget (`void config.onSynced(...)`)

`reconcileInProgress` guards overlap. Slightly less deterministic test behavior. Effort:
Trivial. Risk: none.

## Recommended Action

Fixed: Option A — onSynced moved after schedulePersist (still awaited for tick politeness).

## Technical Details

- **Affected files**: `src/ldk/sync/chain-sync.ts`.

## Acceptance Criteria

- [x] `schedulePersist()` is never delayed by close-record Esplora queries
- [x] Reconciliation still runs at most once concurrently

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (3 agents converged).
- 2026-07-21: Fixed on feat/close-records-engine; tests added (580 total passing).
