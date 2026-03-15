---
status: pending
priority: p2
issue_id: "047"
tags: [code-review, security, fund-safety]
dependencies: []
---

# No seed-vs-mnemonic consistency check on startup

## Problem Statement

`initializeLdk` silently uses the stored IDB seed if one exists, ignoring the freshly derived `ldkSeed` parameter. If IDB was tampered with (DevTools, rogue extension) or the v2→v3 migration failed to clear the old seed, the LDK node operates with a key that doesn't match the mnemonic. Lightning funds would be unrecoverable from the mnemonic.

## Findings

- **File:** `src/ldk/init.ts:120-124` — uses stored seed, ignores `ldkSeed` param
- **Agents:** security-sentinel (HIGH-3), kieran-typescript-reviewer (MEDIUM)

## Proposed Solutions

Add a consistency check on startup:
```typescript
let seed = await getSeed()
if (!seed) {
  await storeDerivedSeed(ldkSeed)
  seed = ldkSeed
} else if (!arraysEqual(seed, ldkSeed)) {
  throw new Error('Stored LDK seed does not match mnemonic derivation — possible corruption')
}
```
- **Effort:** Small | **Risk:** Low

## Acceptance Criteria
- [ ] Startup compares stored seed against mnemonic-derived seed
- [ ] Mismatch throws a clear error rather than silently using wrong key
