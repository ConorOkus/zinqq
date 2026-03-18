---
status: complete
priority: p2
issue_id: "009"
tags: [code-review, security, type-safety]
dependencies: []
---

# getSeed() has no runtime type validation on IndexedDB result

## Problem Statement

`idbGet<T>` uses `as T` cast with no runtime validation. `getSeed()` in `src/ldk/storage/seed.ts` trusts that IndexedDB returns a `Uint8Array`. If stored data is corrupted or a schema migration changes the format, the seed could be silently misinterpreted, leading to wrong key derivation and fund loss.

## Acceptance Criteria

- [ ] `getSeed()` validates `raw instanceof Uint8Array` before returning
- [ ] Throws descriptive error on corrupt/unexpected data type
