# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Force-Close Fund Recovery

### Spendable Output

An on-chain output that LDK hands back to the wallet after a channel closes (typically a force-close), which the wallet must spend itself to reclaim the funds — LDK does not spend it automatically. Each spendable output arrives as a descriptor that is persisted locally until a Sweep consumes it; until then the value is real but invisible to the user's balance.

### Sweep

The named process of spending all persisted Spendable Outputs back into the user's on-chain wallet in a single transaction.

A sweep is self-funded first: the transaction's fee comes out of the swept outputs' own value. A self-funded sweep that cannot pay its own fee falls back to a Subsidized Sweep. Sweeps are all-or-nothing by design — either every pending output sweeps in one transaction or none do. A failed sweep leaves the outputs in a Pending Sweep state and is retried periodically until conditions make it economical; retries speed up when the only blocker is incoming funds. Value too small to clear the network's dust floor even at minimal fees remains stranded.

### Subsidized Sweep

A Sweep whose fee shortfall is covered by the wallet's own confirmed on-chain funds, combined with the swept outputs in a single transaction. A subsidy fires only when net-positive — strictly less is spent than the rescue delivers — and never draws on the Anchor Reserve. When a subsidy would work but the confirmed balance cannot cover it, the wallet surfaces an add-funds prompt with the estimated shortfall as a lower bound.

### Anchor Reserve

On-chain funds the wallet withholds from spending while Lightning channels are open, so a force-close commitment transaction can always be fee-bumped to confirmation even during high-fee periods. The reserve constrains ordinary sends and sweep subsidies alike, and is released when no channels remain open.

### Pending Sweep

The status of Spendable Outputs that have been persisted but not yet successfully swept. A pending sweep whose most recent attempt failed is surfaced to the user as recoverable funds waiting on network conditions; the displayed total is labeled as a lower bound when any entry's value is unreadable or predates value tracking.

### Close Record

The persisted per-channel record of a channel close: which transactions participated and in what role (commitment, closing, sweep), amounts, and attribution back to the channel. Close records store measured facts; user-facing status is derived from them rather than stored. A completed Sweep attributes its transaction to the close records of every channel whose outputs it consumed.

A recorded close transaction is a broadcast-time claim, not a resolution — which close actually ended the channel is settled only by a confirmed spend of the channel's funding output, so a record keeps watching that spend until some close transaction has confirmed (a recorded one may turn out to be a Superseded Commitment).

### Force-Close Recovery

The distinct process of unlocking funds after a force-close whose commitment transaction needs a fee bump to confirm: the user deposits a small amount on-chain, which pays for the child transaction that gets the close confirmed. Distinct from a Sweep — recovery gets the close transaction confirmed, while a sweep reclaims the outputs afterward. Both can be unblocked by an on-chain deposit: recovery uses it to fee-bump the close, a Subsidized Sweep uses it to cover the sweep fee.

Recovery is only ever valid while no closing transaction has confirmed. It is never entered before the wallet's Initial Scan completes (an unscanned wallet looks empty by construction, which would trigger a false deposit ask on every restore), and it exits automatically once any closing transaction confirms for every channel it covers — whether the fee-bumped one or a competing close — because a confirmed close makes the deposit unnecessary.

### Superseded Commitment

A broadcast force-close commitment transaction that can no longer confirm because a competing commitment — typically the counterparty's — already spent the channel's funding output and confirmed. A superseded commitment needs no fee bump and must not hold Force-Close Recovery open; the funds it would have claimed arrive instead via the confirmed close's Spendable Outputs.

### Broadcast Sentinel

A special string returned in place of a transaction id when broadcasting is skipped because the transaction is already in flight or already known to the network. Consumers must treat sentinels as "nothing new happened" — they are valid for deciding a sweep attempt is settled, but must never be recorded as a real transaction id (for example in Close Record attribution). A transaction that shares inputs with the rest of the wallet must not trust a sentinel at all: a concurrently spent input produces the same signal, so success is verified against the chain before any state is discarded.

## Receiving

### JIT Channel

A Lightning channel opened by the LSP at the moment a payment arrives, sized to fit it — how the wallet receives when it lacks inbound capacity. The LSP takes its fee out of the first payment, and the wallet accepts the channel without confirmations only from members of the Trusted LSP Set.

### JIT Quote

The LSP's priced offer to open a JIT Channel: a fee and a validity window. A quote is fresh only within its window — invoices derived from it must expire no later than the quote does, and a stale quote is re-fetched rather than executed.

### Trusted LSP Set

The set of LSP node identities allowed to open zero-confirmation channels to the wallet. Kept as a set rather than a single configured LSP so additional providers can be added without reworking channel-acceptance logic.

## Persistence & Recovery

### Initial Scan

The on-chain wallet's first full chain scan of a session. Until it completes, the wallet's view of its own funds is empty by construction — especially after a restore, when the wallet is freshly created — so any conclusion drawn from an absence of funds ("no UTXOs, therefore act") is invalid before this point. Checks that reason from wallet emptiness are gated on the Initial Scan having completed.

### VSS

The remote versioned key-value store holding an encrypted backup of the wallet's Lightning state. Every critical persist is a dual write — remote first, local second — with version conflicts resolved by retry, so a wallet restored from seed on a new device recovers its channels and pending funds automatically.
