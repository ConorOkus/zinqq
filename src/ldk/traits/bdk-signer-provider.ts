import {
  SignerProvider,
  type SignerProviderInterface,
  type KeysManager,
  Result_CVec_u8ZNoneZ,
  Result_ShutdownScriptNoneZ,
  ShutdownScript,
} from 'lightningdevkit'
import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { captureError } from '../../storage/error-log'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { revealNextAddress, peekAddressAtIndex } from '../../onchain/address-utils'

/**
 * Create a custom SignerProvider that delegates to KeysManager for signing
 * but overrides get_destination_script and get_shutdown_scriptpubkey to
 * return BDK wallet addresses. This ensures all channel close funds
 * (cooperative and force close) go to the on-chain BDK wallet.
 *
 * generate_channel_keys_id uses deterministic HMAC-SHA256 derivation from
 * a purpose-specific key (derived from the LDK seed at init time) so that
 * cross-device recovery produces the same key IDs.
 *
 * get_destination_script derives addresses deterministically from
 * channel_keys_id so that cross-device VSS recovery produces the same
 * scripts. get_shutdown_scriptpubkey uses next_unused_address since
 * shutdown scripts are recorded at channel open time and replayed from
 * serialized state.
 *
 * @param channelKeyHmacKey - 32-byte HMAC key derived from the LDK seed
 *   via HMAC-SHA256(seed, "zinq/channel_keys_id/v1"). The master seed is
 *   NOT held by this provider — only this purpose-limited derived key.
 */
export function createBdkSignerProvider(
  keysManager: KeysManager,
  bdkWallet: Wallet,
  channelKeyHmacKey: Uint8Array
): { signerProvider: SignerProvider } {
  const defaultProvider = keysManager.as_SignerProvider()

  const impl: SignerProviderInterface = {
    generate_channel_keys_id(
      inbound: boolean,
      channel_value_satoshis: bigint,
      user_channel_id: bigint
    ): Uint8Array {
      // Deterministic derivation from a purpose-specific HMAC key + channel
      // parameters for cross-device recovery. The HMAC key was derived at init
      // time as HMAC-SHA256(seed, "zinq/channel_keys_id/v1"), so the master seed
      // is not held in this closure.
      //
      // Wire format (must be reproduced exactly for cross-platform recovery):
      //   [1 byte: inbound flag] [8 bytes: channel_value_satoshis BE]
      //   [8 bytes: user_channel_id lower 64 bits BE] [8 bytes: upper 64 bits BE]
      //
      // WASM u128 note: We operate on the raw BigInt value directly rather than
      // re-encoding through LDK's encodeUint128 (which rejects values >= 2^124).
      const data = new Uint8Array(1 + 8 + 16) // inbound + value + user_channel_id
      data[0] = inbound ? 1 : 0
      const view = new DataView(data.buffer)
      view.setBigUint64(1, channel_value_satoshis, false)
      view.setBigUint64(9, user_channel_id & 0xffffffffffffffffn, false)
      view.setBigUint64(17, user_channel_id >> 64n, false)

      return hmac(sha256, channelKeyHmacKey, data)
    },

    derive_channel_signer(channel_value_satoshis: bigint, channel_keys_id: Uint8Array) {
      return defaultProvider.derive_channel_signer(channel_value_satoshis, channel_keys_id)
    },

    read_chan_signer(reader: Uint8Array) {
      return defaultProvider.read_chan_signer(reader)
    },

    get_destination_script(channel_keys_id: Uint8Array) {
      // No fallback to KeysManager — if BDK address derivation fails, return
      // an error to LDK. LDK will fail the channel operation gracefully.
      // Falling back to KeysManager would send funds to an address the BDK
      // wallet doesn't watch, making them appear lost.
      try {
        const script = peekAddressAtIndex(bdkWallet, channel_keys_id)
        return Result_CVec_u8ZNoneZ.constructor_ok(script)
      } catch (err) {
        captureError(
          'critical',
          'BdkSignerProvider',
          'Cannot derive destination address',
          String(err)
        )
        return Result_CVec_u8ZNoneZ.constructor_err()
      }
    },

    get_shutdown_scriptpubkey() {
      // No fallback to KeysManager — return error if BDK fails.
      try {
        const script = revealNextAddress(bdkWallet, 'BdkSignerProvider')
        // Validate P2WPKH format: OP_0 (0x00) + PUSH_20 (0x14) + 20-byte pubkey hash = 22 bytes
        if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
          const pubkeyHash = script.slice(2)
          const shutdownScript = ShutdownScript.constructor_new_p2wpkh(pubkeyHash)
          return Result_ShutdownScriptNoneZ.constructor_ok(shutdownScript)
        }
        captureError(
          'critical',
          'BdkSignerProvider',
          `Unexpected script format (length=${script.length}, prefix=0x${script[0]?.toString(16)})`
        )
      } catch (err) {
        captureError('critical', 'BdkSignerProvider', 'Cannot derive shutdown address', String(err))
      }
      return Result_ShutdownScriptNoneZ.constructor_err()
    },
  }

  const signerProvider = SignerProvider.new_impl(impl)

  return { signerProvider }
}
