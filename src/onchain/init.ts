import { Wallet, EsploraClient, ChangeSet, type Network } from '@bitcoindevkit/bdk-wallet-web'
import { ONCHAIN_CONFIG } from './config'
import { getChangeset, putChangeset } from './storage/changeset'
import { captureError } from '../storage/error-log'

export interface BdkWallet {
  wallet: Wallet
  esploraClient: EsploraClient
}

/**
 * Create or restore a BDK wallet from persisted ChangeSet.
 * Does NOT perform a chain scan — use fullScanBdkWallet for that.
 */
async function createOrRestoreWallet(
  descriptors: { external: string; internal: string },
  network: Network
): Promise<Wallet> {
  const changesetJson = await getChangeset()

  if (changesetJson) {
    try {
      const changeset = ChangeSet.from_json(changesetJson)
      const wallet = Wallet.load(changeset, descriptors.external, descriptors.internal)
      console.log('[BDK Init] Restored wallet from persisted ChangeSet')
      return wallet
    } catch (err) {
      captureError(
        'warning',
        'BDK Init',
        'Failed to restore from ChangeSet, creating fresh wallet',
        String(err)
      )
    }
  }

  const wallet = Wallet.create(network, descriptors.external, descriptors.internal)
  console.log('[BDK Init] Created fresh wallet')
  return wallet
}

let eagerInitPromise: Promise<BdkWallet> | null = null

/**
 * Eagerly initialize BDK wallet without performing a chain scan.
 * Used by LDK init so the wallet is available for address derivation
 * during ChannelManager/ChannelMonitor deserialization.
 */
export function initializeBdkWalletEager(
  descriptors: { external: string; internal: string },
  network: Network
): Promise<BdkWallet> {
  if (!eagerInitPromise) {
    eagerInitPromise = doInitializeBdkWalletEager(descriptors, network).catch((err) => {
      eagerInitPromise = null
      throw err
    })
  }
  return eagerInitPromise
}

async function doInitializeBdkWalletEager(
  descriptors: { external: string; internal: string },
  network: Network
): Promise<BdkWallet> {
  const esploraClient = new EsploraClient(
    ONCHAIN_CONFIG.esploraUrl,
    ONCHAIN_CONFIG.esploraMaxRetries
  )

  const wallet = await createOrRestoreWallet(descriptors, network)

  return { wallet, esploraClient }
}

/**
 * Perform a full scan on an already-initialized BDK wallet.
 * Used by OnchainProvider when the wallet was created eagerly by LDK init.
 */
export async function fullScanBdkWallet(
  wallet: Wallet,
  esploraClient: EsploraClient
): Promise<void> {
  try {
    const fullScanRequest = wallet.start_full_scan()
    const update = await esploraClient.full_scan(
      fullScanRequest,
      ONCHAIN_CONFIG.fullScanGapLimit,
      ONCHAIN_CONFIG.syncParallelRequests
    )
    wallet.apply_update(update)
    console.log('[BDK] Full scan complete')
  } catch (err) {
    captureError('warning', 'BDK', 'Full scan failed, wallet may have stale data', String(err))
  }

  const staged = wallet.take_staged()
  if (staged && !staged.is_empty()) {
    try {
      await putChangeset(staged.to_json())
    } catch (err) {
      captureError('critical', 'BDK', 'Failed to persist ChangeSet after full scan', String(err))
    }
  }
}
