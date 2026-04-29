---
status: cancelled
priority: p2
issue_id: '264'
tags: [code-review, payjoin, telemetry, privacy]
dependencies: []
---

# Telemetry detail strings include raw upstream error messages (fingerprintable)

## Problem Statement

`payjoin.ts:97` writes the _full_ `err.message` from PDK / fetch / Psbt parse to the local IndexedDB error log:

```ts
captureError('warning', 'Payjoin', bucket, detail ?? reason)
```

The bucket name is collapsed (good) but the local detail string can include:

- PDK's "PSBT input X is missing witness UTXO" — reveals input count
- Fetch error "Failed to fetch https://pj.benalleng.com/..." — reveals relay subpath which encodes session id
- Psbt decode "invalid base64 at offset 1234" — reveals proposal size

These live in IndexedDB indefinitely (capped at 100 entries by `error-log.ts:14`).

## Findings

- **security-sentinel P3-2**: amounts/addresses/txids are not in the messages, but session identifiers and structural fingerprints are. Realistic concern is local-debug exposure if a user shares a debug bundle.

## Proposed Solutions

### Option 1 (recommended) — Strip raw err.message, pass only enum reason

Change throw sites to use only the structured `FallbackReason`:

```ts
throw new PayjoinFallback('network', 'fetch failed')
// instead of
throw new PayjoinFallback('network', err instanceof Error ? err.message : String(err))
```

For debugging, `console.error` could still log the raw message at the throw site (esbuild strips console on mainnet builds — see `error-log.ts:30-31`).

- Pros: no fingerprintable info in IDB; raw messages still visible during local dev.
- Cons: lose granular debug detail in user-shared bundles. Mitigated by local console output during dev.

### Option 2 — Add a debug flag

`localStorage.zinqq_payjoin_debug = '1'` opts users into raw-message capture (per the plan's debug-flag pattern at `docs/plans/.../line 211`).

- Pros: power users can opt in.
- Cons: more surface area; YAGNI for a non-existent feature flag.

## Recommended Action

Option 1. Coordinate with todo #257 (telemetry simplification).

## Technical Details

- Affected file: `src/onchain/payjoin/payjoin.ts` — all `PayjoinFallback` throw sites (~7 sites)

## Acceptance Criteria

- [ ] Raw err.message removed from `PayjoinFallback` constructor calls
- [ ] Generic per-step messages preserved (e.g. 'URI parse failed', 'fetch failed')
- [ ] No change in PayjoinFallback.reason semantics

## Work Log

## Resources

- PR #143
- security-sentinel P3-2 finding

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
