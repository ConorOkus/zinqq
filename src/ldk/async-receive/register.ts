import type { ChannelManager, ReadOnlyNetworkGraph } from 'lightningdevkit'
import { Result_NoneNoneZ_OK } from 'lightningdevkit'
import { decodeServerPaths } from './server-paths'

/**
 * Registration of this wallet as an async-payments recipient with a static
 * invoice server.
 *
 * Handing LDK the server's blinded message paths is all the wallet has to do —
 * `ChannelManager` then drives the offer-paths request, offer construction, and
 * static-invoice delivery internally over onion messages.
 */
export type RegistrationOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'registered'; pathCount: number }
  | { status: 'failed'; reason: string }

export interface RegisterDeps {
  channelManager: Pick<
    ChannelManager,
    'list_usable_channels' | 'set_paths_to_static_invoice_server'
  >
  networkGraph: ReadOnlyNetworkGraph
  /** Raw `staticInvoiceServerPaths` config value: hex of `Vec<BlindedMessagePath>`. */
  pathsConfig: string
  /**
   * Whether a previous session already completed the handshake. The bindings
   * say the registration call "only needs to be called once when the server
   * first takes on the recipient as a client", and a repeat call is not
   * documented as a no-op, so a restored offer means we leave the server alone.
   */
  hasPersistedOffer: boolean
}

/**
 * Build a one-shot registrar.
 *
 * The returned function is safe to call on every tick: it reports why it did
 * nothing rather than throwing, and never calls into the manager twice.
 */
export function createStaticInvoiceServerRegistrar(): (deps: RegisterDeps) => RegistrationOutcome {
  let registered = false

  return function register(deps: RegisterDeps): RegistrationOutcome {
    if (registered) return { status: 'skipped', reason: 'already registered this session' }

    if (deps.pathsConfig.trim() === '') {
      return { status: 'skipped', reason: 'no static invoice server paths configured' }
    }

    if (deps.hasPersistedOffer) {
      return {
        status: 'skipped',
        reason: 'async-receive offer already registered in a prior session',
      }
    }

    // The static invoice carries blinded *payment* paths that must terminate at
    // this wallet through its channel peer, so registering before a channel is
    // usable produces an invoice nobody can pay.
    if (deps.channelManager.list_usable_channels().length === 0) {
      return { status: 'skipped', reason: 'no usable channel yet' }
    }

    const decoded = decodeServerPaths(deps.pathsConfig, deps.networkGraph)
    if (!decoded.ok) {
      return { status: 'failed', reason: decoded.reason }
    }

    const result = deps.channelManager.set_paths_to_static_invoice_server(decoded.paths)
    if (!(result instanceof Result_NoneNoneZ_OK)) {
      return { status: 'failed', reason: 'ChannelManager rejected the static invoice server paths' }
    }

    registered = true
    return { status: 'registered', pathCount: decoded.paths.length }
  }
}
