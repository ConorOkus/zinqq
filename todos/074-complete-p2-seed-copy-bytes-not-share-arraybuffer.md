---
status: complete
priority: p2
issue_id: "074"
tags: [code-review, security, fund-safety]
dependencies: []
---

# Seed cross-realm fallback shares ArrayBuffer — should copy bytes

## Problem Statement

In `getSeed()`, the `ArrayBuffer.isView(raw)` fallback creates a new `Uint8Array` that shares the underlying `ArrayBuffer` with the original. If any code detaches or modifies the buffer (e.g., via `structuredClone` with transfer), the seed becomes silently corrupted.

## Findings

- **File:** `src/ldk/storage/seed.ts`, lines 11-12
- **Identified by:** security-sentinel (M-1)
- `new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)` shares the buffer

## Acceptance Criteria

- [ ] Copy the bytes: `return new Uint8Array(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))`
