/**
 * Derive the node secret key from the LDK seed.
 *
 * LDK's KeysManager derives the node secret as BIP32 m/0' from the seed.
 * This matches the Rust implementation in KeysManager::new().
 */

import { HDKey } from '@scure/bip32'

export function deriveNodeSecret(ldkSeed: Uint8Array): Uint8Array {
  const master = HDKey.fromMasterSeed(ldkSeed)
  const child = master.derive("m/0'")
  if (!child.privateKey) {
    master.wipePrivateData()
    throw new Error('Failed to derive node secret key from LDK seed')
  }
  // Copy the key before wiping the HDKey tree
  const secret = new Uint8Array(child.privateKey)
  child.wipePrivateData()
  master.wipePrivateData()
  return secret
}
