import {
  SignerProvider,
  type SignerProviderInterface,
  type KeysManager,
  Result_CVec_u8ZNoneZ,
  Result_ShutdownScriptNoneZ,
  ShutdownScript,
} from 'lightningdevkit'
import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { putChangeset } from '../../onchain/storage/changeset'

/**
 * Create a custom SignerProvider that delegates to KeysManager for signing
 * but overrides get_destination_script and get_shutdown_scriptpubkey to
 * return BDK wallet addresses. This ensures all channel close funds
 * (cooperative and force close) go to the on-chain BDK wallet.
 *
 * The BDK wallet reference is set lazily via setBdkWallet() since BDK
 * initializes after LDK. Before the wallet is set, falls back to KeysManager defaults.
 */
export function createBdkSignerProvider(keysManager: KeysManager): {
  signerProvider: SignerProvider
  setBdkWallet: (wallet: Wallet | null) => void
} {
  let bdkWallet: Wallet | null = null
  const defaultProvider = keysManager.as_SignerProvider()

  function getScriptFromBdkWallet(): Uint8Array | null {
    if (!bdkWallet) return null
    try {
      const addressInfo = bdkWallet.next_unused_address('external')
      const scriptBytes = addressInfo.address.script_pubkey.as_bytes()

      // Persist the address reveal so BDK syncs this address after restart
      const staged = bdkWallet.take_staged()
      if (staged && !staged.is_empty()) {
        void putChangeset(staged.to_json()).catch((err: unknown) =>
          console.warn('[BdkSignerProvider] Failed to persist address reveal:', err),
        )
      }

      return scriptBytes
    } catch (err) {
      console.warn('[BdkSignerProvider] Failed to get BDK address, falling back to KeysManager:', err)
      return null
    }
  }

  const impl: SignerProviderInterface = {
    generate_channel_keys_id(_inbound: boolean, _channel_value_satoshis: bigint, _user_channel_id: bigint): Uint8Array {
      // Generate a random 32-byte channel keys ID directly instead of
      // delegating to defaultProvider.generate_channel_keys_id(), which
      // re-encodes user_channel_id via encodeUint128. The LDK WASM bindings
      // have an asymmetry: decodeUint128 reads full 128-bit values but
      // encodeUint128 rejects values >= 2^124, causing failures when the
      // user_channel_id has high bits set.
      const channelKeysId = new Uint8Array(32)
      crypto.getRandomValues(channelKeysId)
      return channelKeysId
    },

    derive_channel_signer(channel_value_satoshis: bigint, channel_keys_id: Uint8Array) {
      return defaultProvider.derive_channel_signer(channel_value_satoshis, channel_keys_id)
    },

    read_chan_signer(reader: Uint8Array) {
      return defaultProvider.read_chan_signer(reader)
    },

    get_destination_script(_channel_keys_id: Uint8Array) {
      const script = getScriptFromBdkWallet()
      if (script) {
        return Result_CVec_u8ZNoneZ.constructor_ok(script)
      }
      return defaultProvider.get_destination_script(_channel_keys_id)
    },

    get_shutdown_scriptpubkey() {
      const script = getScriptFromBdkWallet()
      if (script) {
        // Validate P2WPKH format: OP_0 (0x00) + PUSH_20 (0x14) + 20-byte pubkey hash = 22 bytes
        if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
          const pubkeyHash = script.slice(2)
          const shutdownScript = ShutdownScript.constructor_new_p2wpkh(pubkeyHash)
          return Result_ShutdownScriptNoneZ.constructor_ok(shutdownScript)
        }
        console.warn(
          '[BdkSignerProvider] Unexpected script format (length=%d, prefix=0x%s), falling back to KeysManager',
          script.length,
          script[0]?.toString(16),
        )
      }
      return defaultProvider.get_shutdown_scriptpubkey()
    },
  }

  const signerProvider = SignerProvider.new_impl(impl)

  return {
    signerProvider,
    setBdkWallet: (wallet: Wallet | null) => {
      bdkWallet = wallet
    },
  }
}
