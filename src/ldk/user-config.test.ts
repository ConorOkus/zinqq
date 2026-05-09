import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture setter calls so we can assert each one fires with the expected arg.
// Hoisted so the `vi.mock` factory below sees them.
const handshakeConfigSetters = vi.hoisted(() => ({
  set_negotiate_scid_privacy: vi.fn(),
  set_negotiate_anchors_zero_fee_htlc_tx: vi.fn(),
  set_max_inbound_htlc_value_in_flight_percent_of_channel: vi.fn(),
}))
const handshakeLimitsSetters = vi.hoisted(() => ({
  set_trust_own_funding_0conf: vi.fn(),
  set_force_announced_channel_preference: vi.fn(),
}))
const channelConfigSetters = vi.hoisted(() => ({
  set_accept_underpaying_htlcs: vi.fn(),
}))
const setManuallyAcceptInboundChannels = vi.hoisted(() => vi.fn())

vi.mock('lightningdevkit', () => ({
  UserConfig: {
    constructor_default: vi.fn(() => ({
      set_manually_accept_inbound_channels: setManuallyAcceptInboundChannels,
      get_channel_handshake_config: vi.fn(() => handshakeConfigSetters),
      get_channel_handshake_limits: vi.fn(() => handshakeLimitsSetters),
      get_channel_config: vi.fn(() => channelConfigSetters),
    })),
  },
}))

import { createUserConfig } from './user-config'

describe('createUserConfig', () => {
  beforeEach(() => {
    setManuallyAcceptInboundChannels.mockClear()
    Object.values(handshakeConfigSetters).forEach((fn) => fn.mockClear())
    Object.values(handshakeLimitsSetters).forEach((fn) => fn.mockClear())
    Object.values(channelConfigSetters).forEach((fn) => fn.mockClear())
  })

  it('manually accepts inbound channels (so OpenChannelRequest event fires)', () => {
    createUserConfig()
    expect(setManuallyAcceptInboundChannels).toHaveBeenCalledWith(true)
  })

  it('negotiates SCID privacy (LSPS2 references channel pre-confirmation)', () => {
    createUserConfig()
    expect(handshakeConfigSetters.set_negotiate_scid_privacy).toHaveBeenCalledWith(true)
  })

  it('negotiates anchor channels with zero-fee HTLC txs', () => {
    createUserConfig()
    expect(handshakeConfigSetters.set_negotiate_anchors_zero_fee_htlc_tx).toHaveBeenCalledWith(true)
  })

  it('allows the full channel capacity for inbound HTLCs (single large LSPS2 HTLC)', () => {
    createUserConfig()
    expect(
      handshakeConfigSetters.set_max_inbound_htlc_value_in_flight_percent_of_channel
    ).toHaveBeenCalledWith(100)
  })

  it('trusts own funding tx for 0-conf inbound (LSPS2)', () => {
    createUserConfig()
    expect(handshakeLimitsSetters.set_trust_own_funding_0conf).toHaveBeenCalledWith(true)
  })

  // Regression guard: LQwD opens channels whose announce flag differs from
  // our default; without this `false`, OpenChannelRequest is rejected with
  // "announcement preference is different from ours".
  it('disables force-announced-channel-preference (LQwD compatibility)', () => {
    createUserConfig()
    expect(handshakeLimitsSetters.set_force_announced_channel_preference).toHaveBeenCalledWith(
      false
    )
  })

  it('accepts underpaying HTLCs (LSP deducts opening fee before forwarding)', () => {
    createUserConfig()
    expect(channelConfigSetters.set_accept_underpaying_htlcs).toHaveBeenCalledWith(true)
  })
})
