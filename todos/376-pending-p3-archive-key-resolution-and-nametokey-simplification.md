---
status: pending
priority: p3
issue_id: 376
tags: [code-review, ldk, persist, simplification, robustness]
dependencies: []
---

# archive_persisted_channel: add MonitorName→key fallback (and possibly retire the nameToKey map)

## Problem Statement

`archive_persisted_channel(monitor_name)` looks up the storage key in the `nameToKey` map and,
on a miss, logs a warning and returns without deleting — leaving orphaned IDB/VSS blobs and a
stale manifest entry. This is fund-safe (channel already closed) but grows storage and leaves
a manifest key a future restore will try (harmlessly) to fetch.

Separately, the simplicity reviewer notes the whole `nameToKey` map + `keyForMonitor` +
`registerLoadedMonitor` machinery may be replaceable: for **V1** channels
`MonitorName.to_str()` is deterministically `{txid}_{vout}` — the same components as our
`{txid}:{vout}` storage key, differing only in separator. So the key could be derived by a pure
string transform, eliminating the map, the public `registerLoadedMonitor` export, and the
`init.ts` call site (~25-30 lines).

The two findings are related: the string transform is exactly the robust fallback for the
archive miss.

## Findings

- `src/ldk/traits/persist.ts:322-338` — archive no-op on missing `nameToKey` entry.
- `src/ldk/traits/persist.ts:92,286-290,374-379` + `src/ldk/init.ts:~603` — the `nameToKey` map, `keyForMonitor`, `registerLoadedMonitor`, and its call site.
- `node_modules/lightningdevkit/structs/MonitorName.d.mts` — `to_str()` is `{txid}_{vout}` for V1 channels (`constructor_v1_channel`), a bare 64-hex ChannelId for V2 (`constructor_v2_channel`).

## Proposed Solutions

### Option A — add a string-transform fallback, keep the map

In the archive miss branch, derive `key = monitor_name.to_str().replace('_', ':')` and proceed
with the delete. Keeps the map as the fast path + robustness against separator/format drift.

- Effort: Small. Risk: Low.

### Option B — retire the map entirely, use the transform everywhere

Replace `nameToKey`/`keyForMonitor`/`registerLoadedMonitor` with the pure transform.

- **Blocked on:** confirming this wallet can never open a **V2/dual-funded** channel (whose
  `to_str()` has no `_index` and would not match `{txid}:{vout}`). Verify against `user-config.ts`
  (we are LSPS2-inbound-only today, so likely safe — but this must be checked, not assumed).
- Effort: Small (removes ~30 lines). Risk: Medium (breaks silently if V2 ever appears).

## Recommended Action

_(leave blank for triage)_

## Technical Details

- Affected files: `src/ldk/traits/persist.ts`, `src/ldk/init.ts`, `src/ldk/traits/persist.test.ts`.

## Acceptance Criteria

- [ ] archive path deletes the blob even when `nameToKey` has no entry (no orphaned storage).
- [ ] If Option B: documented confirmation that V2-channel MonitorNames cannot occur, or the map retained.
- [ ] tests cover the archive-without-prior-persist path.

## Work Log

- 2026-07-06 — Filed from `/ce:review` of PR #166 (security §2.1 + simplicity #1 + architecture).

## Resources

- PR #166. `node_modules/lightningdevkit/structs/MonitorName.d.mts`.
