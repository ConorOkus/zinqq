import type { Wallet } from '@bitcoindevkit/bdk-wallet-web'
import { putChangeset } from './storage/changeset'

/**
 * Reveal the next unused external address from the BDK wallet and persist
 * the changeset so BDK will sync this address after restart.
 *
 * Returns the raw script_pubkey bytes for the revealed address.
 */
export function revealNextAddress(wallet: Wallet, tag: string): Uint8Array {
  const addressInfo = wallet.next_unused_address('external')
  const scriptBytes = addressInfo.address.script_pubkey.as_bytes()

  const staged = wallet.take_staged()
  if (staged && !staged.is_empty()) {
    void putChangeset(staged.to_json()).catch((err: unknown) =>
      console.warn(`[${tag}] Failed to persist address reveal changeset:`, err)
    )
  }

  return scriptBytes
}
