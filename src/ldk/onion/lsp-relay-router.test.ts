import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  BlindedMessagePath,
  ChannelFeatures,
  Destination,
  Destination_BlindedPath,
  IntroductionNode_DirectedShortChannelId,
  KeysManager,
  Logger,
  MessageContext,
  Network,
  NetworkGraph,
  NodeId,
  Nonce,
  OffersContext,
  Option_u64Z,
  Recipient,
  ReceiveAuthKey,
  Result_NoneLightningErrorZ_OK,
  Result_OnionMessagePathNoneZ_OK,
  initializeWasmFromBinary,
} from 'lightningdevkit'
import { createLspRelayMessageRouter } from './lsp-relay-router'
import { bytesToHex, hexToBytes } from '../utils'

/**
 * Real WASM, not mocks. The claim under test is about what LDK's own router
 * does when a destination is unreachable — a mock would only replay our
 * assumptions, which is how this bug stayed invisible in the first place.
 */
describe('createLspRelayMessageRouter', () => {
  let logger: Logger

  beforeAll(async () => {
    const nodeFs = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as {
      readFileSync: (path: string) => Uint8Array
    }
    await initializeWasmFromBinary(
      new Uint8Array(readFileSync('node_modules/lightningdevkit/liblightningjs.wasm'))
    )
    logger = Logger.new_impl({ log: () => {} })
  })

  /**
   * Pubkeys must be real curve points — LDK traps the runtime on anything else,
   * so these are derived rather than hand-written.
   */
  function keys(fill: number): { manager: KeysManager; hex: string } {
    const manager = KeysManager.constructor_new(
      new Uint8Array(32).fill(fill),
      BigInt(fill),
      0,
      true
    )
    const result = manager.as_NodeSigner().get_node_id(Recipient.LDKRecipient_Node)
    // Narrow by runtime name: the .d.mts declaration for this Result is wrong.
    expect(result.constructor.name).toBe('Result_PublicKeyNoneZ_OK')
    return { manager, hex: bytesToHex((result as unknown as { res: Uint8Array }).res) }
  }

  function setup(fill: number) {
    const { manager } = keys(fill)
    return {
      networkGraph: NetworkGraph.constructor_new(Network.LDKNetwork_Bitcoin, logger),
      entropySource: manager.as_EntropySource(),
    }
  }

  function blindedPathAt(
    introductionNodeHex: string,
    entropySource: KeysManager
  ): BlindedMessagePath {
    return BlindedMessagePath.constructor_one_hop(
      hexToBytes(introductionNodeHex),
      ReceiveAuthKey.constructor_new(new Uint8Array(32).fill(9)),
      MessageContext.constructor_offers(
        OffersContext.constructor_invoice_request(
          Nonce.constructor_from_entropy_source(entropySource.as_EntropySource())
        )
      ),
      entropySource.as_EntropySource()
    )
  }

  /** A destination introducing at `introductionNodeHex`, the shape of a BOLT 12 offer path. */
  function destinationAt(introductionNodeHex: string, entropySource: KeysManager): Destination {
    return Destination.constructor_blinded_path(blindedPathAt(introductionNodeHex, entropySource))
  }

  /**
   * Announce a channel the way Rapid Gossip Sync does — partial data, no
   * signatures, no node announcement. This is exactly the shape of graph the
   * router exists for: it can answer an SCID lookup and nothing else.
   */
  function announceRgsChannel(graph: NetworkGraph, scid: bigint, aHex: string, bHex: string): void {
    // node_id_1 is the lexicographically smaller pubkey, as the spec requires.
    const first = aHex < bHex ? aHex : bHex
    const second = aHex < bHex ? bHex : aHex
    const result = graph.add_channel_from_partial_announcement(
      scid,
      Option_u64Z.constructor_some(1_000_000n),
      BigInt(Math.floor(Date.now() / 1000)),
      ChannelFeatures.constructor_empty(),
      NodeId.constructor_from_pubkey(hexToBytes(first)),
      NodeId.constructor_from_pubkey(hexToBytes(second))
    )
    expect(result).toBeInstanceOf(Result_NoneLightningErrorZ_OK)
  }

  /**
   * A destination whose introduction node is in compact (directed SCID) form.
   * This is what a real BOLT 12 offer carries, and the only shape that makes
   * the router resolve anything — `constructor_one_hop` alone yields a plain
   * node id, which needs no lookup at all.
   */
  function compactDestinationAt(
    introductionNodeHex: string,
    entropySource: KeysManager,
    graph: NetworkGraph
  ): Destination {
    const path = blindedPathAt(introductionNodeHex, entropySource)
    const readOnly = graph.read_only()
    try {
      path.use_compact_introduction_node(readOnly)
    } finally {
      readOnly.free()
    }
    expect(path.introduction_node()).toBeInstanceOf(IntroductionNode_DirectedShortChannelId)
    return Destination.constructor_blinded_path(path)
  }

  it('relays through the LSP when the destination is not a connected peer', () => {
    const { networkGraph, entropySource } = setup(1)
    const lsp = keys(2)
    const stranger = keys(3)
    const sender = keys(4)
    const onRelay = vi.fn()
    const onUnroutable = vi.fn()

    const router = createLspRelayMessageRouter({
      networkGraph,
      entropySource,
      lspNodeId: lsp.hex,
      onRelay,
      onUnroutable,
    })

    const result = router.find_path(
      hexToBytes(sender.hex),
      [hexToBytes(lsp.hex)], // LSP connected; the stranger is not
      destinationAt(stranger.hex, stranger.manager)
    )

    expect(result).toBeInstanceOf(Result_OnionMessagePathNoneZ_OK)
    const path = (result as Result_OnionMessagePathNoneZ_OK).res
    expect(path.get_intermediate_nodes().map(bytesToHex)).toEqual([lsp.hex])
    expect(path.get_destination()).toBeInstanceOf(Destination_BlindedPath)
    expect(onRelay).toHaveBeenCalledWith(stranger.hex)
    expect(onUnroutable).not.toHaveBeenCalled()
  })

  it('resolves a compact introduction node from the channel graph, then relays', () => {
    const { networkGraph, entropySource } = setup(1)
    const lsp = keys(2)
    const stranger = keys(3)
    const sender = keys(4)
    const other = keys(5)
    const onRelay = vi.fn()
    const onUnroutable = vi.fn()

    // The one thing an RGS-only graph can answer: which nodes a channel joins.
    announceRgsChannel(networkGraph, 42n, stranger.hex, other.hex)

    const router = createLspRelayMessageRouter({
      networkGraph,
      entropySource,
      lspNodeId: lsp.hex,
      onRelay,
      onUnroutable,
    })

    const result = router.find_path(
      hexToBytes(sender.hex),
      [hexToBytes(lsp.hex)],
      compactDestinationAt(stranger.hex, stranger.manager, networkGraph)
    )

    expect(result).toBeInstanceOf(Result_OnionMessagePathNoneZ_OK)
    // The SCID was resolved back to the stranger's pubkey, not dropped.
    expect(onRelay).toHaveBeenCalledWith(stranger.hex)
    expect(onUnroutable).not.toHaveBeenCalled()
    const path = (result as Result_OnionMessagePathNoneZ_OK).res
    expect(path.get_intermediate_nodes().map(bytesToHex)).toEqual([lsp.hex])
  })

  it('reports a compact introduction node whose SCID is missing from the graph', () => {
    const announced = setup(1)
    const lsp = keys(2)
    const stranger = keys(3)
    const sender = keys(4)
    const other = keys(5)
    const onRelay = vi.fn()
    const onUnroutable = vi.fn()

    // Compact the path against a graph that has the channel, then route it
    // through a node whose graph does not — an offer built before our sync
    // caught up, or against a channel we never learned about.
    announceRgsChannel(announced.networkGraph, 42n, stranger.hex, other.hex)
    const destination = compactDestinationAt(stranger.hex, stranger.manager, announced.networkGraph)

    const empty = setup(6)
    const router = createLspRelayMessageRouter({
      networkGraph: empty.networkGraph,
      entropySource: empty.entropySource,
      lspNodeId: lsp.hex,
      onRelay,
      onUnroutable,
    })

    const result = router.find_path(hexToBytes(sender.hex), [hexToBytes(lsp.hex)], destination)

    expect(result).not.toBeInstanceOf(Result_OnionMessagePathNoneZ_OK)
    expect(onUnroutable).toHaveBeenCalledWith(
      'introduction node SCID is not in the network graph',
      null
    )
    expect(onRelay).not.toHaveBeenCalled()
  })

  it('reports rather than silently dropping when the LSP is not connected', () => {
    const { networkGraph, entropySource } = setup(1)
    const lsp = keys(2)
    const stranger = keys(3)
    const sender = keys(4)
    const onUnroutable = vi.fn()

    const router = createLspRelayMessageRouter({
      networkGraph,
      entropySource,
      lspNodeId: lsp.hex,
      onUnroutable,
    })

    const result = router.find_path(
      hexToBytes(sender.hex),
      [], // no peers at all
      destinationAt(stranger.hex, stranger.manager)
    )

    expect(result).not.toBeInstanceOf(Result_OnionMessagePathNoneZ_OK)
    expect(onUnroutable).toHaveBeenCalledWith('LSP is not a connected peer', stranger.hex)
  })

  it('leaves a directly reachable destination to the default router', () => {
    const { networkGraph, entropySource } = setup(1)
    const lsp = keys(2)
    const peer = keys(3)
    const sender = keys(4)
    const onRelay = vi.fn()

    const router = createLspRelayMessageRouter({
      networkGraph,
      entropySource,
      lspNodeId: lsp.hex,
      onRelay,
    })

    const result = router.find_path(
      hexToBytes(sender.hex),
      [hexToBytes(peer.hex)],
      destinationAt(peer.hex, peer.manager)
    )

    expect(result).toBeInstanceOf(Result_OnionMessagePathNoneZ_OK)
    // Direct: the default router routes to a connected peer with no relay hop.
    expect((result as Result_OnionMessagePathNoneZ_OK).res.get_intermediate_nodes()).toHaveLength(0)
    expect(onRelay).not.toHaveBeenCalled()
  })
})
