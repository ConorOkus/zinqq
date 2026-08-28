---
title: 'Real LDK WASM in vitest, and the null-pointer wrapper trap'
category: integration-issues
date: 2026-08-27
tags: [ldk, wasm, vitest, testing, bindings, async-payments]
severity: medium
components: [src/ldk/async-receive/handshake-harness.test.ts, node_modules/lightningdevkit]
---

# Real LDK WASM in vitest, and the null-pointer wrapper trap

## Problem

Every LDK-touching test in this repo mocks `lightningdevkit` wholesale. That is fine for logic around the bindings, but it means no test can answer "does LDK actually do X when we call Y?" — the mock only ever confirms what we already believed. Building the async-payments recipient role needed exactly that kind of answer.

Two things were in the way: no known way to load the WASM under vitest, and two binding shapes that make naive assertions silently pass.

## Solution

### Loading real LDK in vitest

`initializeWasmWebFetch('/liblightningjs.wasm')` needs a served asset and does not work under vitest. The bindings also export `initializeWasmFromBinary(bin: Uint8Array)`, which works from disk:

```ts
const nodeFs = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as {
  readFileSync: (path: string) => Uint8Array
}
const bin = readFileSync('node_modules/lightningdevkit/liblightningjs.wasm')
await initializeWasmFromBinary(new Uint8Array(bin))
```

The non-literal specifier is deliberate. `tsconfig.app.json` omits node types so browser code cannot reach for node APIs by accident; a literal `import { readFileSync } from 'node:fs'` fails typecheck, and adding `"node"` to the app project's `types` would remove that guardrail for all of `src/`.

A full node (ChannelManager + OnionMessenger) can then be constructed in a test with `Logger.new_impl`, `FeeEstimator.new_impl`, `BroadcasterInterface.new_impl`, `Persist.new_impl`, a `ChainMonitor`, and `KeysManager` supplying entropy, node-signer, and signer-provider.

### Trap 1: accessors return Result wrappers, not values

`NodeSigner.get_node_id()` returns a `Result`, not a public key. `expect(nodeId).toBeTruthy()` passes on the Result object, so a test can look green while holding nothing useful.

Worse, the `.d.mts` type can be wrong about _which_ Result. The declaration says `Result_PublicKeySecp256k1ErrorZ`; at runtime it is `Result_PublicKeyNoneZ_OK`. Narrowing against the declared class fails silently. Check `constructor.name` at runtime rather than trusting the declaration.

### Trap 2: "empty" is a wrapper around a null pointer, not `null`

`OnionMessageHandler.next_onion_message_for_peer(peer)` returns an `OnionMessage` object even when the queue is empty. It is not `null`, it is truthy, and calling `.write()` on it traps WASM with `RuntimeError: unreachable`.

The inner pointer is the only honest signal:

```ts
function hasMessage(msg: OnionMessage): boolean {
  return (msg as unknown as { ptr: bigint }).ptr !== 0n
}
```

Expect this shape wherever the C bindings model an optional return as a struct. `Result_OfferNoneZ_OK` wrapping a null-pointer `Offer` is the same hazard, which is why `readAsyncReceiveOffer` in `src/ldk/async-receive/offer.ts` checks `ptr` before calling `to_str()`.

## What the harness established

With real LDK rather than mocks:

- `set_paths_to_static_invoice_server` accepts decoded paths and returns `Result_NoneNoneZ_OK`.
- A `BlindedMessagePath` round-trips through `write()` / `constructor_read`, which is what makes hex-encoded configuration viable.
- **With zero usable channels, registration succeeds and then nothing is sent** — five pumped `timer_tick_occurred` calls with the server connected as an onion-message peer produced no outbound message. The static invoice's blinded _payment_ paths must terminate at the wallet through a channel peer, so the channel gate is a precondition LDK enforces.

That last point is the payoff. A mocked test would have asserted whatever we assumed; the real bindings contradicted the assumption.

## Prevention

- Never assert `toBeTruthy()` on an LDK accessor's return. Narrow to the concrete `_OK` class, then check the inner value.
- When a binding models "nothing" as an object, check `ptr !== 0n` rather than `!= null`.
- Verify the runtime class name before trusting a `.d.mts` Result declaration.
- Reach for the real-WASM harness when the question is about LDK's behavior. Keep mocks for logic _around_ LDK.

## Related

- `docs/solutions/integration-issues/bolt12-offer-creation-missing-paths.md` — Result narrowing and version-specific enum codes
- `docs/plans/2026-08-27-001-feat-async-payments-recipient-role-plan.md` — assumptions A4 and A5, settled by this harness
