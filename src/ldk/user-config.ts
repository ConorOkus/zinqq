import { UserConfig } from 'lightningdevkit'
import { JIT_ACCEPT_UNDERPAYING_HTLCS, JIT_MAX_INBOUND_INFLIGHT_PCT } from './jit-channel-config'

/**
 * Build the LDK `UserConfig` for our wallet.
 *
 * Extracted to a dedicated module so it can be unit tested without pulling
 * in the rest of `init.ts`'s dependency chain.
 */
export function createUserConfig(): UserConfig {
  const config = UserConfig.constructor_default()
  config.set_manually_accept_inbound_channels(true)

  // Advertise the `htlc_hold` feature bit, which async payments needs.
  //
  // This flag does two things, and the second is the one we're after: it makes
  // us willing to hold HTLCs for channel peers that ask, *and* it is the only
  // lever that sets `htlc_hold` in our init and node features. Leaving it false
  // is why the LSP reported `HtlcHold: not supported` for every connected peer.
  //
  // LDK's docs warn this "should only be set to true for nodes which expect to
  // be online reliably", which a browser wallet plainly is not. That warning is
  // about the holding half, and it does not bite here: holding only applies to
  // HTLCs we forward, and this is a leaf node with one channel to the LSP that
  // never forwards. So the behaviour is inert and the advertisement is real.
  config.set_enable_htlc_hold(true)

  // LSPS2 JIT channels require option_scid_alias (reference channel before confirmation)
  const handshakeConfig = config.get_channel_handshake_config()
  handshakeConfig.set_negotiate_scid_privacy(true)

  // Enable anchor channels (zero-fee HTLC anchors). The LSP opens anchor
  // channels; BumpTransactionEventHandler (step 14) handles CPFP fee bumping.
  // No on-chain reserve gate is needed — raw LDK does not enforce one, and
  // the LSP is already trusted via accept_inbound_channel_from_trusted_peer_0conf.
  handshakeConfig.set_negotiate_anchors_zero_fee_htlc_tx(true)

  // LSPS2: allow the full channel capacity for inbound HTLCs. The default (10%)
  // is too restrictive for JIT channels where the entire payment arrives in a
  // single HTLC that may be close to the channel capacity.
  handshakeConfig.set_max_inbound_htlc_value_in_flight_percent_of_channel(
    JIT_MAX_INBOUND_INFLIGHT_PCT
  )

  // Allow 0-conf inbound channels from trusted peers (the LSP)
  const handshakeLimits = config.get_channel_handshake_limits()
  handshakeLimits.set_trust_own_funding_0conf(true)

  // LDK rejects opens whose announce flag differs from our default
  // (`announce_for_forwarding=false`) with "announcement preference is
  // different from ours". Some LSPs diverge; turn the check off. Originally
  // added for LQwD (removed); retained defensively — verify against a live
  // Megalith channel open before tightening, since it's the sole LSP now.
  handshakeLimits.set_force_announced_channel_preference(false)

  // LSPS2: the LSP deducts an opening fee before forwarding, so the HTLC amount
  // will be less than the invoice amount. Allow claiming these underpaying HTLCs —
  // the fee is validated at invoice creation time.
  const channelConfig = config.get_channel_config()
  channelConfig.set_accept_underpaying_htlcs(JIT_ACCEPT_UNDERPAYING_HTLCS)

  return config
}
