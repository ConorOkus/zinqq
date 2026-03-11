---
status: pending
priority: p2
issue_id: "011"
tags: [code-review, architecture, reliability]
dependencies: []
---

# WASM re-initialization not guarded against double-mount

## Problem Statement

`initializeLdk()` in `src/ldk/init.ts` calls `initializeWasmWebFetch()` without checking if WASM is already loaded. React StrictMode double-mounts components in development, causing two concurrent `initializeLdk()` calls. The `cancelled` flag in `LdkProvider` prevents duplicate state updates but not duplicate WASM initialization, which may throw or cause undefined behavior.

## Acceptance Criteria

- [ ] Module-level promise deduplication so concurrent calls share the same initialization
- [ ] Second call awaits the first rather than starting a new init
