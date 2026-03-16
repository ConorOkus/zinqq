import {
  Wallet,
  EsploraClient,
  ChangeSet,
  type Network,
} from '@bitcoindevkit/bdk-wallet-web'
import { ONCHAIN_CONFIG } from './config'
import { getChangeset, putChangeset } from './storage/changeset'

export interface BdkWallet {
  wallet: Wallet
  esploraClient: EsploraClient
  isNewWallet: boolean
}

let bdkInitPromise: Promise<BdkWallet> | null = null

export function initializeBdkWallet(
  descriptors: { external: string; internal: string },
  network: Network,
): Promise<BdkWallet> {
  if (!bdkInitPromise) {
    bdkInitPromise = doInitializeBdkWallet(descriptors, network).catch((err) => {
      bdkInitPromise = null
      throw err
    })
  }
  return bdkInitPromise
}

async function doInitializeBdkWallet(
  descriptors: { external: string; internal: string },
  network: Network,
): Promise<BdkWallet> {
  const esploraClient = new EsploraClient(
    ONCHAIN_CONFIG.esploraUrl,
    ONCHAIN_CONFIG.esploraMaxRetries,
  )

  // Try to restore from persisted ChangeSet, otherwise create fresh
  const changesetJson = await getChangeset()
  let wallet: Wallet
  let isNewWallet: boolean

  if (changesetJson) {
    try {
      const changeset = ChangeSet.from_json(changesetJson)
      wallet = Wallet.load(changeset, descriptors.external, descriptors.internal)
      isNewWallet = false
      console.log('[BDK Init] Restored wallet from persisted ChangeSet')
    } catch (err) {
      console.warn('[BDK Init] Failed to restore from ChangeSet, creating fresh wallet:', err)
      wallet = Wallet.create(network, descriptors.external, descriptors.internal)
      isNewWallet = true
    }
  } else {
    wallet = Wallet.create(network, descriptors.external, descriptors.internal)
    isNewWallet = true
    console.log('[BDK Init] Created fresh wallet')
  }

  // Always do a full scan on init to discover all addresses, including
  // any that were revealed by the LDK event handler (sweep destinations)
  // but may not have been persisted in the changeset.
  try {
    const fullScanRequest = wallet.start_full_scan()
    const update = await esploraClient.full_scan(
      fullScanRequest,
      ONCHAIN_CONFIG.fullScanGapLimit,
      ONCHAIN_CONFIG.syncParallelRequests,
    )
    wallet.apply_update(update)
    console.log('[BDK Init] Initial full scan complete')
  } catch (err) {
    // Non-fatal: wallet is usable but may have stale data
    console.warn('[BDK Init] Initial sync failed, wallet may have stale data:', err)
  }

  // Persist any changes from init + sync
  const staged = wallet.take_staged()
  if (staged && !staged.is_empty()) {
    try {
      await putChangeset(staged.to_json())
    } catch (err) {
      console.error('[BDK Init] CRITICAL: failed to persist initial ChangeSet:', err)
    }
  }

  return { wallet, esploraClient, isNewWallet }
}
