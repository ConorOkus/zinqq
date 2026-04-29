---
status: cancelled
priority: p2
issue_id: '258'
tags: [code-review, payjoin, config, infrastructure]
dependencies: []
---

# `OHTTP_RELAY` should live in `ONCHAIN_CONFIG` with env override

## Problem Statement

`payjoin.ts:13` hardcodes `const OHTTP_RELAY = 'https://pj.benalleng.com'` as a module constant. Compare with `src/onchain/config.ts:39-42` where esplora and explorer URLs are env-overridable through `ONCHAIN_CONFIG` (with `VITE_*` overrides).

If pj.benalleng.com goes down or rate-limits us, swapping relays requires a code change and redeploy — exactly the wrong response in an incident.

## Findings

- **architecture-strategist #6**: third-party network endpoints belong in config, not as module constants. Repo already has the pattern.
- The plan originally called for "ordered fallback across 3 relays" (line 418 of plan). Current code uses one. Even without multi-relay logic, the seam should exist.

## Proposed Solutions

### Option 1 (recommended) — Promote to `ONCHAIN_CONFIG`, ship single-relay first

```ts
// src/onchain/config.ts
export const ONCHAIN_CONFIG = {
  // ...
  payjoinOhttpRelays: parseRelays(import.meta.env.VITE_PAYJOIN_OHTTP_RELAYS) ?? [
    'https://pj.benalleng.com',
    'https://pj.bobspacebkk.com',
    'https://ohttp.achow101.com',
  ],
}
```

`tryPayjoinSend` reads `ONCHAIN_CONFIG.payjoinOhttpRelays[0]`. Multi-relay fallback stays deferred per the existing comment at `payjoin.ts:7-12`, but the seam is in place.

- Pros: incident response can swap relays via env var; no code change required.
- Cons: small config surface addition.

### Option 2 — Add only the env override, keep the array literal in payjoin.ts

Add `VITE_PAYJOIN_OHTTP_RELAYS` parse at the top of payjoin.ts.

- Pros: minimal touch.
- Cons: split between config and module file — fights the existing ONCHAIN_CONFIG pattern.

## Recommended Action

Option 1. Bundles future multi-relay work with no extra cost today.

## Technical Details

- Affected files:
  - `src/onchain/config.ts` — add `payjoinOhttpRelays: string[]`
  - `src/onchain/payjoin/payjoin.ts:13` — read from `ONCHAIN_CONFIG`
- Vite env: `VITE_PAYJOIN_OHTTP_RELAYS=url1,url2,url3` (comma-separated)
- Document override in `docs/payjoin-build.md` or a new ops note

## Acceptance Criteria

- [ ] `ONCHAIN_CONFIG.payjoinOhttpRelays` populated with default 3 relays
- [ ] `VITE_PAYJOIN_OHTTP_RELAYS` env var honored
- [ ] `tryPayjoinSend` reads from config
- [ ] Existing tests pass

## Work Log

## Resources

- PR #143
- `src/onchain/config.ts` — existing pattern
- Plan line 418 — multi-relay fallback note

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
