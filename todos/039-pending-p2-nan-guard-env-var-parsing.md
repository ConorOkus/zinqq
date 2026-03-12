---
status: pending
priority: p2
issue_id: "039"
tags: [code-review, quality, proxy]
dependencies: []
---

# No NaN guard on parseInt for env var parsing

## Problem Statement

`parseInt(env.MAX_MESSAGE_SIZE, 10)` and `parseInt(env.ALLOWED_PORTS, 10)` return `NaN` if the values are misconfigured. `NaN > NaN` is `false`, silently disabling the size limit. `allowedPorts.includes(NaN)` blocks all ports. Failure modes are asymmetric and confusing.

## Findings

- **Source:** TypeScript Reviewer
- **Location:** `proxy/src/index.ts` lines 32-35

## Proposed Solutions

### Option A: Validate env vars at handler start (Recommended)
Return 500 if any parsed value is NaN.

- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Worker returns 500 with clear message when env vars parse to NaN
