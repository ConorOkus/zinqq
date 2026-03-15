---
status: pending
priority: p3
issue_id: "058"
tags: [code-review, quality, error-handling]
dependencies: []
---

# Add try/catch around generateAddress in Receive.tsx

## Problem Statement

`generateAddress()` calls into BDK WASM (`wallet.next_unused_address`) and can throw if the WASM module encounters an error. The call in Receive.tsx has no error handling — an exception would be swallowed by the useEffect and leave the page showing no address with no error feedback.

## Findings

**Location:** `src/pages/Receive.tsx`, lines 11-15

The `generateAddress()` call inside the useEffect has no try/catch. If it throws, the component stays in an ambiguous state (status is `ready` but `address` is `null`).

Flagged by: architecture-strategist

## Proposed Solutions

### Option A: Wrap in try/catch with local error state

Add a `const [error, setError] = useState<string | null>(null)` and catch exceptions from `generateAddress()`, displaying the error message.

- **Pros:** Defensive, clear error feedback
- **Cons:** Adds a few lines
- **Effort:** Small (10 min)
- **Risk:** None

## Acceptance Criteria

- [ ] `generateAddress()` call wrapped in try/catch
- [ ] Error state displayed to user if address generation fails
- [ ] Test added for error case
