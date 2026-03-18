---
status: complete
priority: p3
issue_id: "012"
tags: [code-review, security]
dependencies: []
---

# Seed material persists in memory after KeysManager initialization

## Problem Statement

In `src/ldk/init.ts`, the `seed` Uint8Array remains in closure scope after being passed to `KeysManager.constructor_new()`. JavaScript cannot securely erase memory, but `seed.fill(0)` after init reduces the exposure window. Additionally, `keysManager` is exposed in React context, making key material broadly accessible.

## Acceptance Criteria

- [ ] `seed.fill(0)` called immediately after `KeysManager.constructor_new()`
- [ ] Consider narrowing `LdkNode` interface to exclude `keysManager` from public context
