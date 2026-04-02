import {
  WalletSource,
  type WalletSourceInterface,
  Utxo,
  OutPoint as LdkOutPoint,
  TxOut as LdkTxOut,
  Result_CVec_UtxoZNoneZ,
  Result_CVec_u8ZNoneZ,
  Result_TransactionNoneZ,
} from 'lightningdevkit'
import { type Wallet, SignOptions, Psbt } from '@bitcoindevkit/bdk-wallet-web'
import { revealNextAddress } from '../../onchain/address-utils'
import { captureError } from '../../storage/error-log'
import { hexToBytes } from '../utils'

// P2WPKH witness: ~107 weight units (DER sig + compressed pubkey)
const P2WPKH_SATISFACTION_WEIGHT = 107n

/**
 * Create a WalletSource backed by a BDK wallet. This adapts BDK's UTXO
 * management and signing to LDK's CoinSelectionSource interface (via the
 * Wallet wrapper), enabling BumpTransactionEventHandler to use BDK UTXOs
 * for anchor channel CPFP fee bumping.
 */
export function createBdkWalletSource(bdkWallet: Wallet): WalletSource {
  const impl: WalletSourceInterface = {
    list_confirmed_utxos(): Result_CVec_UtxoZNoneZ {
      try {
        const unspent = bdkWallet.list_unspent()
        const utxos: Utxo[] = []

        for (const output of unspent) {
          // Only include confirmed UTXOs — LDK requires confirmed inputs for
          // anchor CPFP. An unconfirmed parent could be dropped from the mempool,
          // invalidating the CPFP child and leaving the force-close stuck.
          const wtx = bdkWallet.get_tx(output.outpoint.txid)
          if (!wtx || !wtx.chain_position.is_confirmed) continue

          const bdkOutpoint = output.outpoint
          const bdkTxout = output.txout

          // Convert BDK txid (display order, big-endian) to LDK (internal order, little-endian)
          const txidHex = bdkOutpoint.txid.toString()
          const txidBytes = Uint8Array.from(hexToBytes(txidHex)).reverse()

          const ldkOutpoint = LdkOutPoint.constructor_new(txidBytes, bdkOutpoint.vout)
          const scriptBytes = bdkTxout.script_pubkey.as_bytes()
          const valueSats = bdkTxout.value.to_sat()
          const ldkTxout = LdkTxOut.constructor_new(valueSats, scriptBytes)

          utxos.push(Utxo.constructor_new(ldkOutpoint, ldkTxout, P2WPKH_SATISFACTION_WEIGHT))
        }

        return Result_CVec_UtxoZNoneZ.constructor_ok(utxos)
      } catch (err: unknown) {
        captureError('critical', 'BDK WalletSource', 'list_confirmed_utxos failed', String(err))
        return Result_CVec_UtxoZNoneZ.constructor_err()
      }
    },

    get_change_script(): Result_CVec_u8ZNoneZ {
      try {
        const scriptBytes = revealNextAddress(bdkWallet, 'CPFP change')
        return Result_CVec_u8ZNoneZ.constructor_ok(scriptBytes)
      } catch (err: unknown) {
        captureError('critical', 'BDK WalletSource', 'get_change_script failed', String(err))
        return Result_CVec_u8ZNoneZ.constructor_err()
      }
    },

    sign_psbt(psbtBytes: Uint8Array): Result_TransactionNoneZ {
      try {
        // Convert raw PSBT bytes to base64 for BDK's Psbt.from_string()
        const base64 = uint8ArrayToBase64(psbtBytes)
        const psbt = Psbt.from_string(base64)

        bdkWallet.sign(psbt, new SignOptions())

        const signedTx = psbt.extract_tx()
        const txBytes = signedTx.to_bytes()
        return Result_TransactionNoneZ.constructor_ok(txBytes)
      } catch (err: unknown) {
        captureError('critical', 'BDK WalletSource', 'sign_psbt failed', String(err))
        return Result_TransactionNoneZ.constructor_err()
      }
    },
  }

  return WalletSource.new_impl(impl)
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}
