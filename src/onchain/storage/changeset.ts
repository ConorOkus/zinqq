import { ChangeSet } from '@bitcoindevkit/bdk-wallet-web'
import { idbGet, idbPut } from '../../storage/idb'

const CHANGESET_KEY = 'primary'

export async function getChangeset(): Promise<string | undefined> {
  return idbGet<string>('bdk_changeset', CHANGESET_KEY)
}

/**
 * Merge a changeset delta into the persisted changeset and save.
 * BDK's take_staged() returns only what changed since the last call,
 * so we must merge into the accumulated state to preserve earlier
 * fields (like network type from Wallet.create()).
 */
export async function putChangeset(deltaJson: string): Promise<void> {
  const existingJson = await getChangeset()
  let merged: ChangeSet
  if (existingJson) {
    merged = ChangeSet.from_json(existingJson)
    merged.merge(ChangeSet.from_json(deltaJson))
  } else {
    merged = ChangeSet.from_json(deltaJson)
  }
  await idbPut('bdk_changeset', CHANGESET_KEY, merged.to_json())
}
