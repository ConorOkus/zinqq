# Residual Review Findings — feat/onchain-send-all

Source: ce-code-review run `20260725-225417-1d813c27` (plan `docs/plans/2026-07-25-002-feat-onchain-send-all-plan.md`), reviewed at `c11ff39`. Findings the pipeline reported but did not apply in-branch; each is durable as a tracker ticket.

## Residual Review Findings

- **P1** — `src/onchain/context.tsx:277` — Send-all drain spends untrusted-pending UTXOs, diverging from displayed amount (confidence 100, three independent reviewers). Deferred: the input-set exclusion needs BDK-WASM API verification and an R2 semantics decision. Tracked in [#180](https://github.com/ConorOkus/zinqq/issues/180).
- **P1** — `src/onchain/context.tsx` — Fund-safety context wiring lacks a direct provider-level test harness. Partially addressed in-branch (drift-check logic extracted to `makeDriftCheck` with direct unit tests); the provider wiring remainder is tracked in [#182](https://github.com/ConorOkus/zinqq/issues/182).
- **P2** — `src/onchain/context.tsx:288` — Reserve disclosure overstates the retained anchor reserve by the change-output fee (confidence 75). Deferred: the fee allowance hardcodes a change-descriptor vbyte assumption that needs confirming. Tracked in [#181](https://github.com/ConorOkus/zinqq/issues/181).

No settled-decision conflicts were reported by implementation or review.
