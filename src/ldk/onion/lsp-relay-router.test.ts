import { describe, it, expect, beforeAll, vi } from 'vitest'
import {
  BlindedMessagePath,
  Destination,
  Destination_BlindedPath,
  KeysManager,
  Logger,
  MessageContext,
  Network,
  NetworkGraph,
  Nonce,
  OffersContext,
  Recipient,
  ReceiveAuthKey,
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

  /** A destination introducing at `introductionNodeHex`, the shape of a BOLT 12 offer path. */
  function destinationAt(introductionNodeHex: string, entropySource: KeysManager): Destination {
    const path = BlindedMessagePath.constructor_one_hop(
      hexToBytes(introductionNodeHex),
      ReceiveAuthKey.constructor_new(new Uint8Array(32).fill(9)),
      MessageContext.constructor_offers(
        OffersContext.constructor_invoice_request(
          Nonce.constructor_from_entropy_source(entropySource.as_EntropySource())
        )
      ),
      entropySource.as_EntropySource()
    )
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
