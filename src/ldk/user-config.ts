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
