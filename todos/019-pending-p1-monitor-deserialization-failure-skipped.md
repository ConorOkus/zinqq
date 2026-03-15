---
status: complete
priority: p1
issue_id: "019"
tags: [code-review, security, fund-safety]
dependencies: []
---

# ChannelMonitor deserialization failure silently skipped

## Problem Statement

In `src/ldk/init.ts`, the `deserializeMonitors` function skips any monitor that fails to deserialize with only a `console.error`. The wallet starts without that channel's monitor, meaning its funds become unrecoverable — a counterparty could broadcast a revoked commitment and the wallet would not respond.

## Findings

- **Source:** Security Sentinel (C3)
- **Location:** `src/ldk/init.ts` `deserializeMonitors()` function, the else branch
- **Evidence:** `console.error(\`[LDK Init] Failed to deserialize ChannelMonitor: ${key}\`)`
- **Impact:** Silent loss of a channel's funds if even one monitor is corrupted

## Proposed Solutions

### Option A: Hard error on any deserialization failure
- Throw an error halting initialization if any monitor fails to deserialize
- **Pros:** Safe, prevents silent fund loss
- **Cons:** One corrupted monitor blocks the entire wallet
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Any ChannelMonitor deserialization failure halts initialization
- [ ] Error message identifies which monitor key failed
- [ ] Error surfaces in React context error state

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |

## Resources

- PR: #3
- File: `src/ldk/init.ts`
