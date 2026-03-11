import {
  initializeWasmWebFetch,
  KeysManager,
  Recipient,
  Result_PublicKeyNoneZ_OK,
  type Logger,
  type FeeEstimator,
  type BroadcasterInterface,
  type Persist,
} from 'lightningdevkit'
import { getSeed, generateAndStoreSeed } from './storage/seed'
import { createLogger } from './traits/logger'
import { createFeeEstimator } from './traits/fee-estimator'
import { createBroadcaster } from './traits/broadcaster'
import { createPersister } from './traits/persist'
import { SIGNET_CONFIG } from './config'

export interface LdkNode {
  nodeId: string
  keysManager: KeysManager
  logger: Logger
  feeEstimator: FeeEstimator
  broadcaster: BroadcasterInterface
  persister: Persist
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function initializeLdk(): Promise<LdkNode> {
  // 1. Load WASM binary
  await initializeWasmWebFetch('/liblightningjs.wasm')

  // 2. Get or create seed
  let seed = await getSeed()
  if (!seed) {
    seed = await generateAndStoreSeed()
  }

  // 3. Initialize KeysManager with current timestamp for ephemeral key uniqueness
  const nowMs = Date.now()
  const startingTimeSecs = BigInt(Math.floor(nowMs / 1000))
  const startingTimeNanos = (nowMs % 1000) * 1_000_000
  const keysManager = KeysManager.constructor_new(seed, startingTimeSecs, startingTimeNanos)

  // 4. Create trait implementations
  const logger = createLogger()
  const feeEstimator = createFeeEstimator(SIGNET_CONFIG.esploraUrl)
  const broadcaster = createBroadcaster(SIGNET_CONFIG.esploraUrl)
  const persister = createPersister()

  // 5. Derive node public key
  const nodeIdResult = keysManager.as_NodeSigner().get_node_id(Recipient.LDKRecipient_Node)
  if (!nodeIdResult.is_ok()) {
    throw new Error('Failed to derive node ID from KeysManager')
  }
  if (!(nodeIdResult instanceof Result_PublicKeyNoneZ_OK)) {
    throw new Error('Failed to derive node ID from KeysManager')
  }
  const nodeId = bytesToHex(nodeIdResult.res)

  return { nodeId, keysManager, logger, feeEstimator, broadcaster, persister }
}
