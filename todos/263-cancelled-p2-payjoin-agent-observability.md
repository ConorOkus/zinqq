---
status: cancelled
priority: p2
issue_id: '263'
tags: [code-review, payjoin, agent-native, telemetry, observability]
dependencies: []
---

# Surface validator reasons on `PayjoinFallback` + export read API for error log

## Problem Statement

Two related agent-native gaps:

1. `validateProposal` returns `{ ok: false, reason: '<specific failure>' }` (e.g., `'sender input dropped'`, `'recipient amount decreased'`). At `payjoin.ts:259` the reason is folded into `PayjoinFallback`'s `message`, but `.message` is conventionally for human display while `.reason` is for programmatic dispatch. Test harnesses can read `.reason === 'validation'` but cannot programmatically distinguish the _specific_ validator failure.

2. `captureError` writes to `ldk_error_log` in IndexedDB but `src/storage/error-log.ts` exports no read API. To verify "did the Payjoin succeed bucket fire?" an agent must reach into `idbGetAll('ldk_error_log')` directly. This is the primary agent-native gap.

## Findings

- **agent-native-reviewer #1**: validator outcomes are unobservable as structured data — the specific failure string is buried in `captureError` detail.
- **agent-native-reviewer #2**: no read API on `ldk_error_log`.
- **agent-native-reviewer score: 2/5** — core function is right; operational levers around it are UI-grade only.

## Proposed Solutions

### Option 1 (recommended) — Both: structured `validationReason` field + `getRecentErrors` export

Part A:

```ts
export class PayjoinFallback extends Error {
  constructor(
    public readonly reason: FallbackReason,
    message: string,
    public readonly validationReason?: string // populated when reason === 'validation'
  ) {
    super(message)
    this.name = 'PayjoinFallback'
  }
}
```

At the validation throw site:

```ts
if (!validation.ok) {
  throw new PayjoinFallback('validation', validation.reason, validation.reason)
}
```

Part B: add to `src/storage/error-log.ts`:

```ts
export async function getRecentErrors(filter?: {
  source?: string
  severity?: ErrorSeverity
  since?: number
}): Promise<ErrorLogEntry[]> {
  const all = await idbGetAll<ErrorLogEntry>('ldk_error_log')
  // filter + sort by timestamp desc
}
```

- Pros: unblocks every "did telemetry fire" agent assertion; programmatic validator reason for tests; bucketing for privacy stays unchanged.
- Cons: small API surface addition.

## Recommended Action

Option 1. Both changes are small and independent of the other todos.

## Technical Details

- Affected files:
  - `src/onchain/payjoin/payjoin.ts` — extend `PayjoinFallback` ctor, populate `validationReason`
  - `src/storage/error-log.ts` — add `getRecentErrors` export
  - `src/storage/idb.ts` already exports `idbGetAll` (no change needed)
- Tests: assert `validationReason` is populated on a validation-failure case in payjoin.test.ts

## Acceptance Criteria

- [ ] `PayjoinFallback.validationReason` populated when `reason === 'validation'`
- [ ] `getRecentErrors` exported with filter
- [ ] Test confirms validationReason on a validator-rejected proposal
- [ ] No change to telemetry bucketing (still 2 buckets in captureError name)

## Work Log

## Resources

- PR #143
- agent-native-reviewer agent report
- `src/storage/error-log.ts`

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
