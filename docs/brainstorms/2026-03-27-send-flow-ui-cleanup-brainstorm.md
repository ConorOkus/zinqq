# Brainstorm: Send Flow UI Cleanup

**Date:** 2026-03-27
**Status:** Ready for planning

## What We're Building

Three targeted removals from the Lightning send flow screens to simplify the UI:

1. **Remove "Type" row from Lightning review screen** — The BOLT 11/BOLT 12 badge on the ln-review screen is implementation detail that doesn't help the user decide whether to confirm the payment.

2. **Remove "sent via Lightning" from Lightning success screen** — Replace with "sent successfully" to match the on-chain success screen. Users don't need to know the payment rail after the fact.

3. **Remove preimage hex button from Lightning success screen** — The rounded-border copyable preimage snippet (`abc123...xyz789`) is developer-facing data that clutters the success state.

## Why This Approach

The send flow should present only what matters to the user: who they're paying, how much, and whether it succeeded. Protocol-level details (BOLT type, preimage) add noise without helping the user make decisions or take action.

Unifying the success screen language ("sent successfully" for both on-chain and Lightning) also simplifies the mental model — a send is a send regardless of the underlying rail.

## Key Decisions

- **On-chain screens unchanged** — The explorer link and txid display on oc-success remain as-is since they provide actionable information (verifying the transaction on-chain).
- **`typeBadge` function can be removed** — It's only used in the ln-review Type row. Dead code after this change.
- **ln-success subtitle becomes "sent successfully"** — Consistent with the oc-success screen rather than being blank.

## Scope

### Files affected

- `src/pages/Send.tsx` — All three changes are in this single file

### Elements to remove

1. Lines ~887-892: The "Type" / `typeBadge()` row in the ln-review section
2. Lines ~103-110: The `typeBadge()` helper function (becomes dead code)
3. Line ~732: Change "sent via Lightning" → "sent successfully"
4. Lines ~734-741: The preimage hex `<button>` block in ln-success

### Elements to keep

- `preimage` in the `SendStep` type and state transitions (may be needed internally)
- On-chain success screen (explorer link, txid display)
- All other review screen rows (To, Amount, Fee, Total)

## Open Questions

None — scope is well-defined.
