import { describe, it, expect, beforeAll } from 'vitest'
import {
  AsyncPaymentsContext,
  BestBlock,
  BlindedMessagePath,
  BroadcasterInterface,
  ChainMonitor,
  ChainParameters,
  ChannelFeatures,
  ChannelManager,
  DefaultMessageRouter,
  DefaultRouter,
  FeeEstimator,
  IgnoringMessageHandler,
  Init,
  InitFeatures,
  IntroductionNode_DirectedShortChannelId,
  Logger,
  MessageContext,
  MultiThreadedLockableScore,
  Option_CVec_ThirtyTwoBytesZZ,
  Option_SocketAddressZ,
  Option_u64Z,
  OnionMessage,
  Network,
  NetworkGraph,
  NodeId,
  Option_FilterZ,
  OnionMessenger,
  PeerStorageKey,
  Persist,
  Recipient,
  Result_BlindedMessagePathDecodeErrorZ_OK,
  Result_NoneLightningErrorZ_OK,
  Result_NoneNoneZ_OK,
  Result_PublicKeyNoneZ_OK,
  ProbabilisticScorer,
  ProbabilisticScoringDecayParameters,
  ProbabilisticScoringFeeParameters,
  KeysManager,
  UserConfig,
  initializeWasmFromBinary,
} from 'lightningdevkit'
import { bytesToHex } from '../utils'

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

function buildNode(seedByte: number, userConfig?: UserConfig) {
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
    userConfig ?? UserConfig.constructor_default(),
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

  // Regression guard for the feature bit async payments needs. `enable_htlc_hold`
  // is the only lever that sets it, so a refactor dropping that call — or an LDK
  // default change — would silently go back to advertising "not supported",
  // which is what the LSP observed before this was turned on.
  it('advertises htlc_hold in the features built from the real wallet config', async () => {
    const { createUserConfig } = await import('../user-config')
    const node = buildNode(7, createUserConfig())
    const handler = node.channelManager.as_BaseMessageHandler()

    expect(
      handler.provided_init_features(new Uint8Array(33).fill(2)).supports_htlc_hold()
    ).toBeTruthy()
    expect(handler.provided_node_features().supports_htlc_hold()).toBeTruthy()
  })

  it('does not advertise htlc_hold under LDK defaults', () => {
    const node = buildNode(7)
    const handler = node.channelManager.as_BaseMessageHandler()

    expect(
      handler.provided_init_features(new Uint8Array(33).fill(2)).supports_htlc_hold()
    ).toBeFalsy()
  })

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
  // The wire shape for server paths is hex of `Vec<BlindedMessagePath>::write()`
  // — ldk-node's uniffi convention. The bindings expose no vector reader, so the
  // parser segments the blob itself. This proves the segmentation against paths
  // built by real LDK rather than mocks.
  //
  // Caveat worth keeping visible: the 2-byte count prefix here is constructed by
  // hand from LDK's CollectionLength encoding, because the JS bindings cannot
  // call Rust's `Vec::write()`. Per-path decode and round-trip segmentation are
  // proven; the prefix width still needs confirming against a real server blob.
  it('decodes a hand-framed Vec<BlindedMessagePath> blob built from real paths', async () => {
    const server = buildNode(9)
    const a = serverPath(server).write()
    const b = serverPath(server).write()

    const bytes = new Uint8Array(2 + a.length + b.length)
    bytes[0] = 0
    bytes[1] = 2
    bytes.set(a, 2)
    bytes.set(b, 2 + a.length)
    const hex = Array.from(bytes)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')

    const { decodeServerPaths } = await import('./server-paths')

    const graph = server.networkGraph.read_only()
    try {
      const result = decodeServerPaths(hex, graph)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.paths).toHaveLength(2)
    } finally {
      // The bindings require read locks to be released explicitly; the
      // finalizer throws instead of freeing.
      graph.free()
    }
  })

  it('accepts a real blob whose paths introduce at different nodes', async () => {
    // What a live ldk-server actually emits: `blinded_paths_for_async_recipient`
    // introduces each path at one of the server's peers, so the introduction
    // nodes differ from each other and from the server. Nothing here is
    // pinnable, and requiring it to be would reject every genuine blob.
    const server = buildNode(9)
    const stranger = buildNode(11)
    const a = serverPath(server).write()
    const b = serverPath(stranger).write()

    const bytes = new Uint8Array(2 + a.length + b.length)
    bytes[0] = 0
    bytes[1] = 2
    bytes.set(a, 2)
    bytes.set(b, 2 + a.length)
    const hex = Array.from(bytes)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')

    const { decodeServerPaths } = await import('./server-paths')

    const graph = server.networkGraph.read_only()
    try {
      const result = decodeServerPaths(hex, graph)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.paths).toHaveLength(2)
    } finally {
      graph.free()
    }
  })

  it('rejects a real path whose compact introduction node is not in the graph', async () => {
    // The gate that survived the removal of the node-id pin, against real
    // bindings rather than a mock. It is easy to get wrong in a way that reads
    // as correct: LDK signals "not found" with a NodeId wrapping a null
    // pointer, whose as_slice() is 33 zero bytes, so a length-only check
    // accepts the all-zeros pubkey and the path sails through.
    const server = buildNode(13)
    const other = buildNode(15)
    const path = serverPath(server)

    // Announce the channel RGS-style so the path can be compacted, then decode
    // against a graph that has never seen it.
    const [first, second] =
      bytesToHex(server.nodeId) < bytesToHex(other.nodeId)
        ? [server.nodeId, other.nodeId]
        : [other.nodeId, server.nodeId]
    expect(
      server.networkGraph.add_channel_from_partial_announcement(
        4242n,
        Option_u64Z.constructor_some(1_000_000n),
        BigInt(Math.floor(Date.now() / 1000)),
        ChannelFeatures.constructor_empty(),
        NodeId.constructor_from_pubkey(first),
        NodeId.constructor_from_pubkey(second)
      )
    ).toBeInstanceOf(Result_NoneLightningErrorZ_OK)

    const populated = server.networkGraph.read_only()
    try {
      path.use_compact_introduction_node(populated)
    } finally {
      populated.free()
    }
    expect(path.introduction_node()).toBeInstanceOf(IntroductionNode_DirectedShortChannelId)

    const ser = path.write()
    const bytes = new Uint8Array(2 + ser.length)
    bytes[0] = 0
    bytes[1] = 1
    bytes.set(ser, 2)
    const hex = Array.from(bytes)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')

    const { decodeServerPaths } = await import('./server-paths')

    const emptyGraph = NetworkGraph.constructor_new(
      Network.LDKNetwork_Bitcoin,
      Logger.new_impl({ log: () => {} })
    ).read_only()
    try {
      const result = decodeServerPaths(hex, emptyGraph)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('unresolvable introduction node')
    } finally {
      emptyGraph.free()
    }
  })

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
