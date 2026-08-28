import { describe, it, expect, beforeAll } from 'vitest'
import {
  AsyncPaymentsContext,
  BestBlock,
  BlindedMessagePath,
  BroadcasterInterface,
  ChainMonitor,
  ChainParameters,
  ChannelManager,
  DefaultMessageRouter,
  DefaultRouter,
  FeeEstimator,
  IgnoringMessageHandler,
  Init,
  InitFeatures,
  Logger,
  MessageContext,
  MultiThreadedLockableScore,
  Option_CVec_ThirtyTwoBytesZZ,
  Option_SocketAddressZ,
  Option_u64Z,
  OnionMessage,
  Network,
  NetworkGraph,
  Option_FilterZ,
  OnionMessenger,
  PeerStorageKey,
  Persist,
  Recipient,
  Result_BlindedMessagePathDecodeErrorZ_OK,
  Result_NoneNoneZ_OK,
  Result_PublicKeyNoneZ_OK,
  ProbabilisticScorer,
  ProbabilisticScoringDecayParameters,
  ProbabilisticScoringFeeParameters,
  KeysManager,
  UserConfig,
  initializeWasmFromBinary,
} from 'lightningdevkit'

/**
 * Real-WASM harness for the async-payments recipient role.
 *
 * Every other LDK test in this repo mocks `lightningdevkit`, which means none of
 * them can tell us whether LDK actually *does* anything when we hand it static
 * invoice server paths. `initializeWasmFromBinary` lets vitest load the real
 * bindings from disk, so this suite exercises the client half of the handshake
 * against real LDK rather than against our own assumptions about it.
 */

/**
 * Whether the messenger actually handed us a message.
 *
 * `next_onion_message_for_peer` does NOT return JS `null` when the queue is
 * empty — it returns an `OnionMessage` wrapper around a null WASM pointer, and
 * calling `.write()` on that traps the runtime with `unreachable`. The inner
 * pointer is the only honest emptiness signal.
 */
function hasMessage(msg: OnionMessage): boolean {
  return (msg as unknown as { ptr: bigint }).ptr !== 0n
}

function buildNode(seedByte: number) {
  const logger = Logger.new_impl({ log: () => {} })
  const feeEstimator = FeeEstimator.new_impl({ get_est_sat_per_1000_weight: () => 253 })
  const broadcaster = BroadcasterInterface.new_impl({ broadcast_transactions: () => {} })
  const persister = Persist.new_impl({
    persist_new_channel: () => 0,
    update_persisted_channel: () => 0,
    archive_persisted_channel: () => {},
    get_and_clear_completed_updates: () => [],
  })

  const seed = new Uint8Array(32).fill(seedByte)
  const keysManager = KeysManager.constructor_new(seed, BigInt(seedByte), 0, true)

  const chainMonitor = ChainMonitor.constructor_new(
    Option_FilterZ.constructor_none(),
    broadcaster,
    logger,
    feeEstimator,
    persister,
    keysManager.as_EntropySource(),
    PeerStorageKey.constructor_new(new Uint8Array(32).fill(seedByte + 1))
  )

  const networkGraph = NetworkGraph.constructor_new(Network.LDKNetwork_Regtest, logger)
  const scorer = ProbabilisticScorer.constructor_new(
    ProbabilisticScoringDecayParameters.constructor_default(),
    networkGraph,
    logger
  )
  const router = DefaultRouter.constructor_new(
    networkGraph,
    logger,
    keysManager.as_EntropySource(),
    MultiThreadedLockableScore.constructor_new(scorer.as_Score()).as_LockableScore(),
    ProbabilisticScoringFeeParameters.constructor_default()
  )
  const messageRouter = DefaultMessageRouter.constructor_new(
    networkGraph,
    keysManager.as_EntropySource()
  )

  const bestBlock = BestBlock.constructor_new(new Uint8Array(32).fill(1), 1)
  const channelManager = ChannelManager.constructor_new(
    feeEstimator,
    chainMonitor.as_Watch(),
    broadcaster,
    router.as_Router(),
    messageRouter.as_MessageRouter(),
    logger,
    keysManager.as_EntropySource(),
    keysManager.as_NodeSigner(),
    keysManager.as_SignerProvider(),
    UserConfig.constructor_default(),
    ChainParameters.constructor_new(Network.LDKNetwork_Regtest, bestBlock),
    Math.floor(Date.now() / 1000)
  )

  const ignorer = IgnoringMessageHandler.constructor_new()
  const onionMessenger = OnionMessenger.constructor_new(
    keysManager.as_EntropySource(),
    keysManager.as_NodeSigner(),
    logger,
    channelManager.as_NodeIdLookUp(),
    messageRouter.as_MessageRouter(),
    channelManager.as_OffersMessageHandler(),
    channelManager.as_AsyncPaymentsMessageHandler(),
    channelManager.as_DNSResolverMessageHandler(),
    ignorer.as_CustomOnionMessageHandler()
  )

  const nodeIdResult = keysManager.as_NodeSigner().get_node_id(Recipient.LDKRecipient_Node)
  if (!(nodeIdResult instanceof Result_PublicKeyNoneZ_OK)) {
    throw new Error('failed to derive node id in harness')
  }

  return {
    keysManager,
    channelManager,
    onionMessenger,
    networkGraph,
    nodeId: nodeIdResult.res,
  }
}

describe('async-receive handshake (real WASM)', () => {
  beforeAll(async () => {
    // Loaded through a non-literal specifier on purpose. tsconfig.app.json
    // deliberately omits node types so browser code can't reach for node APIs
    // by accident, and this suite is the one place under src/ that legitimately
    // needs the filesystem.
    const nodeFs = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as {
      readFileSync: (path: string) => Uint8Array
    }
    const bin = readFileSync('node_modules/lightningdevkit/liblightningjs.wasm')
    await initializeWasmFromBinary(new Uint8Array(bin))
  })

  function serverPath(server: ReturnType<typeof buildNode>) {
    const context = MessageContext.constructor_async_payments(
      AsyncPaymentsContext.constructor_offer_paths_request(
        new Uint8Array(16).fill(3),
        Option_u64Z.constructor_none()
      )
    )
    return BlindedMessagePath.constructor_one_hop(
      server.nodeId,
      server.keysManager.as_NodeSigner().get_receive_auth_key(),
      context,
      server.keysManager.as_EntropySource()
    )
  }

  function connect(from: ReturnType<typeof buildNode>, to: ReturnType<typeof buildNode>) {
    from.onionMessenger
      .as_BaseMessageHandler()
      .peer_connected(
        to.nodeId,
        Init.constructor_new(
          InitFeatures.constructor_empty(),
          Option_CVec_ThirtyTwoBytesZZ.constructor_none(),
          Option_SocketAddressZ.constructor_none()
        ),
        false
      )
  }

  it('builds a real ChannelManager and onion messenger', () => {
    const node = buildNode(7)
    expect(node.channelManager).toBeTruthy()
    expect(node.onionMessenger).toBeTruthy()
    expect(node.nodeId).toHaveLength(33)
  })

  it('accepts real decoded blinded paths as static invoice server paths', () => {
    const recipient = buildNode(7)
    const server = buildNode(9)

    const result = recipient.channelManager.set_paths_to_static_invoice_server([serverPath(server)])

    expect(result).toBeInstanceOf(Result_NoneNoneZ_OK)
  })

  it('round-trips a blinded path through write/constructor_read', () => {
    const server = buildNode(9)
    const encoded = serverPath(server).write()

    const decoded = BlindedMessagePath.constructor_read(encoded)

    expect(decoded).toBeInstanceOf(Result_BlindedMessagePathDecodeErrorZ_OK)
  })

  // The finding this suite exists for. Registration succeeds, the server is a
  // connected onion-message peer, and ticks are pumped — yet LDK enqueues
  // nothing while no channel is usable. The handshake's reply path has to
  // terminate at this node through a channel peer, so the channel gate in
  // `register.ts` is a precondition LDK enforces, not a precaution we invented.
  it('enqueues nothing while no channel is usable, even after registering', () => {
    const recipient = buildNode(7)
    const server = buildNode(9)
    connect(recipient, server)

    const registration = recipient.channelManager.set_paths_to_static_invoice_server([
      serverPath(server),
    ])
    expect(registration).toBeInstanceOf(Result_NoneNoneZ_OK)
    expect(recipient.channelManager.list_usable_channels()).toHaveLength(0)

    const handler = recipient.onionMessenger.as_OnionMessageHandler()
    for (let i = 0; i < 5; i++) {
      recipient.channelManager.timer_tick_occurred()
      expect(hasMessage(handler.next_onion_message_for_peer(server.nodeId))).toBe(false)
    }
  })
})
