---
status: pending
priority: p3
issue_id: '348'
tags: [code-review, documentation, idb, pr-157]
dependencies: []
---

# Document the IDB-write ordering invariant relied on by `persistChannelManagerIdbOnly`

## Problem Statement

`persistChannelManager` writes VSS first, then IDB. `persistChannelManagerIdbOnly`
(visibility-hidden path) writes IDB only. Their interaction is currently safe
_because of an undocumented invariant_: the IDB-only path always reads the
**current** `cm.write()` so its bytes are at-least-as-fresh as anything the
scheduler might still write.

But this is fragile. A future refactor that, e.g., reorders the steps inside
`persistChannelManager` to write IDB _before_ VSS would silently regress —
the visibility-only write could end up older than the in-flight scheduler
write completes.

(Security-sentinel rates this race higher in #340 and proposes an active
queue. Architecture rates it lower and proposes documenting the invariant.
This todo is the docs-only path; #340 is the harder fix.)

## Findings

- architecture-strategist P3.
- security-sentinel P2-4 takes the stronger position (active queue).

## Proposed Solutions

### Option A — Comment the invariant at both sites

```ts
// src/ldk/storage/persist-cm.ts at persistChannelManager (line ~30)
// IMPORTANT: This function MUST write VSS first, then IDB. The visibility-hidden
// fallback `persistChannelManagerIdbOnly` reads `cm.write()` at call time and
// races against this function's IDB write. Because IDB is the LAST step here,
// `persistChannelManagerIdbOnly`'s bytes are always >= our IDB bytes — so a
// race produces no regression. Reordering breaks this guarantee.

// src/ldk/storage/persist-cm.ts at persistChannelManagerIdbOnly (line ~85)
// See comment on persistChannelManager: this function relies on that one
// writing IDB last. If you reorder there, also serialize here.
```

- Pros: trivial.
- Cons: load-bearing comment is fragile — a regression test would be better.

### Option B — Add a regression test asserting IDB write happens after VSS write

In `persist-cm.test.ts`, mock both `vssClient.putObject` and `idbPut`, capture
call order, assert VSS resolves first.

- Pros: load-bearing invariant becomes machine-checkable.
- Cons: minor test churn.
- Effort: Small.
- Risk: None.

## Recommended Action

(filled during triage; if #340 lands, this becomes moot)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`, `src/ldk/storage/persist-cm.test.ts`

## Acceptance Criteria

- [ ] Either ordering is enforced by test, or invariant is documented at both functions
- [ ] If #340 lands first, this todo is closed as superseded

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #340 (active queue solution)
