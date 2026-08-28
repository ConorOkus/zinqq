import type { ChannelManager } from 'lightningdevkit'
import { Result_OfferNoneZ_OK } from 'lightningdevkit'

/**
 * Reading and publishing the async-receive offer.
 *
 * The offer only exists once the static invoice server has persisted our static
 * invoice, which happens asynchronously after registration. Until then the
 * self-built offer stands, so the receive screen is never empty.
 */

/**
 * Read the async-receive offer from the manager, or null if the handshake has
 * not completed.
 *
 * Defends against the bindings' null-pointer wrapper: several LDK accessors
 * return a struct around a null WASM pointer rather than JS `null`, and calling
 * through to it traps the runtime.
 */
export function readAsyncReceiveOffer(
  channelManager: Pick<ChannelManager, 'get_async_receive_offer'>
): string | null {
  const result = channelManager.get_async_receive_offer()
  if (!(result instanceof Result_OfferNoneZ_OK)) return null

  const offer = result.res
  if (!offer || (offer as unknown as { ptr?: bigint }).ptr === 0n) return null

  const encoded = offer.to_str()
  return encoded && encoded.length > 0 ? encoded : null
}

export interface PublishedOfferInput {
  /** Offer read from the manager this session, if the handshake has completed. */
  asyncOffer: string | null
  /** Async-receive offer restored from a previous session, if any. */
  persistedAsyncOffer: string | null
  /** The wallet's own offer, which requires it to be online to be paid. */
  selfBuiltOffer: string | null
  /** True once this session's polling budget for the async offer is spent. */
  revalidationExhausted: boolean
}

export type PublishedOffer = {
  offer: string | null
  source: 'async' | 'self-built' | 'none'
  /** True when a restored async offer could not be reconfirmed and was dropped. */
  demoted: boolean
}

/**
 * Decide which offer the receive screen publishes.
 *
 * Kept a pure function because there is no test file for `src/ldk/context.tsx`
 * and covering precedence through the context would mean standing up the whole
 * node. The context holds only the wiring.
 */
export function resolvePublishedOffer(input: PublishedOfferInput): PublishedOffer {
  // The manager is authoritative (KTD2). A live read always wins.
  if (input.asyncOffer) {
    return { offer: input.asyncOffer, source: 'async', demoted: false }
  }

  if (input.persistedAsyncOffer) {
    // A restored offer is a first-paint cache. It stands while revalidation is
    // still in flight, but once the budget is spent without the manager
    // confirming it, publishing it would strand an unpayable code.
    if (input.revalidationExhausted) {
      return { offer: input.selfBuiltOffer, source: 'self-built', demoted: true }
    }
    return { offer: input.persistedAsyncOffer, source: 'async', demoted: false }
  }

  if (input.selfBuiltOffer) {
    return { offer: input.selfBuiltOffer, source: 'self-built', demoted: false }
  }

  return { offer: null, source: 'none', demoted: false }
}
