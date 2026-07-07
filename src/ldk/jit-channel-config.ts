/**
 * Single source of truth for the two channel settings a JIT (LSP-opened,
 * 0-conf) receive depends on.
 *
 * These are applied in two places that MUST stay in agreement:
 *   - wallet-globally in `createUserConfig` (user-config.ts), as the safety net;
 *   - per-channel via `ChannelConfigOverrides` on the 0-conf accept
 *     (event-handler.ts `buildJitChannelConfigOverrides`).
 *
 * Keeping them here means the per-channel override can never silently drift from
 * the global default.
 */

/**
 * Accept HTLCs that pay less than the invoice amount. The LSP deducts its
 * opening fee before forwarding, so the arriving JIT HTLC is below the invoice
 * amount; the fee is validated at invoice-creation time.
 */
export const JIT_ACCEPT_UNDERPAYING_HTLCS = true

/**
 * Allow the full channel capacity for a single inbound HTLC. LDK's default
 * (10%) is too restrictive for JIT channels, where the entire payment arrives
 * in one HTLC that may be close to channel capacity.
 */
export const JIT_MAX_INBOUND_INFLIGHT_PCT = 100
