import {
  DefaultMessageRouter,
  Destination_BlindedPath,
  Destination_Node,
  IntroductionNode_NodeId,
  MessageRouter,
  OnionMessagePath,
  Result_OnionMessagePathNoneZ,
  Result_OnionMessagePathNoneZ_OK,
  type Destination,
  type EntropySource,
  type NetworkGraph,
} from 'lightningdevkit'
import { bytesToHex, hexToBytes } from '../utils'

/**
 * Why this exists: RGS carries channels, not node announcements.
 *
 * `DefaultMessageRouter` reaches an onion-message destination one of two ways —
 * the introduction node is already a connected peer, or it has announced
 * addresses in the network graph. A graph built purely from Rapid Gossip Sync
 * satisfies neither for a stranger's node: the LDK-hosted snapshot yields 5474
 * nodes and *zero* `announcement_info`, so every node in it is addressless.
 *
 * The consequence is that paying any BOLT 12 offer whose blinded path does not
 * introduce at our own LSP dies silently. The router does not report this: as
 * of 0.2.4 it returns `Ok` with an empty `first_node_addresses` (verified
 * against the real bindings, not the docs). `OnionMessenger` then finds a first
 * hop that is neither connected nor dialable, drops the message with
 * `InvalidFirstHop`, and emits no `Event::ConnectionNeeded` — that event needs
 * an address it does not have. The `invoice_request` is never transmitted, and
 * the payment sits until it expires, which reads to the user as a timeout with
 * no error anywhere.
 *
 * So when the default router gives up we relay through the LSP instead: it is a
 * connected peer, so the first hop always works, and it forwards the message
 * onward. This is what mobile wallets do generally — lightning-kmp sends every
 * onion message via its peer rather than routing itself.
 *
 * The limit worth knowing: an LDK-based relay only forwards to peers it is
 * *already connected to* (it will not dial), so this reaches a destination only
 * if our LSP happens to be connected to that introduction node. A well-connected
 * LSP usually is; a small one usually is not. When the relay is not viable we
 * report it through `onUnroutable` rather than failing mute, which is the part
 * that turns a silent timeout into something diagnosable.
 */
export interface LspRelayRouterOptions {
  networkGraph: NetworkGraph
  entropySource: EntropySource
  /** Hex node id of the LSP to relay through. Empty disables the fallback. */
  lspNodeId: string
  /** Called when we hand a message to the LSP to forward. */
  onRelay?: (introductionNodeHex: string) => void
  /** Called when neither a direct path nor the relay is available. */
  onUnroutable?: (reason: string, introductionNodeHex: string | null) => void
}

/**
 * Hex node id of a destination's first hop, or null when it cannot be
 * determined — an unresolved compact introduction node whose SCID is missing
 * from our graph.
 *
 * `Destination` and `IntroductionNode` are tagged unions; the bindings model
 * each variant as a subclass, so narrowing is the only way to read the payload.
 */
function firstNodeHex(destination: Destination): string | null {
  if (destination instanceof Destination_Node) {
    return bytesToHex(destination.node)
  }
  if (destination instanceof Destination_BlindedPath) {
    const introduction = destination.blinded_path.introduction_node()
    if (introduction instanceof IntroductionNode_NodeId) {
      return bytesToHex(introduction.node_id)
    }
  }
  return null
}

/**
 * A `MessageRouter` that falls back to relaying through the LSP when the
 * default router cannot reach a destination directly.
 *
 * `create_blinded_paths` is delegated untouched — inbound paths for our own
 * offers are built exactly as before, including compact introduction nodes.
 */
export function createLspRelayMessageRouter({
  networkGraph,
  entropySource,
  lspNodeId,
  onRelay,
  onUnroutable,
}: LspRelayRouterOptions): MessageRouter {
  const inner = DefaultMessageRouter.constructor_new(networkGraph, entropySource).as_MessageRouter()

  return MessageRouter.new_impl({
    find_path(sender, peers, destination) {
      // Resolve a compact introduction node to a pubkey first. This is the one
      // thing RGS *can* answer: compact resolution is a channel lookup, and
      // channels are what the snapshot carries.
      const resolved = destination.clone()
      const readOnlyGraph = networkGraph.read_only()
      try {
        resolved.resolve(readOnlyGraph)
      } finally {
        // Deliberately manual: this lock's finalizer throws rather than
        // no-ops, and an unfreed one surfaces detached from this call site.
        readOnlyGraph.free()
      }

      const introductionNode = firstNodeHex(resolved)
      const peerHexes = peers.map(bytesToHex)

      // Already connected to the first hop — the default router's path works.
      // Clone before handing the destination to a call that takes it by value;
      // the wrapper we were handed is owned by our caller.
      if (introductionNode !== null && peerHexes.includes(introductionNode)) {
        return inner.find_path(sender, peers, destination.clone())
      }

      const direct = inner.find_path(sender, peers, destination.clone())
      if (
        direct instanceof Result_OnionMessagePathNoneZ_OK &&
        direct.res.get_first_node_addresses().length > 0
      ) {
        // The graph has an address, so LDK can dial it itself via
        // Event::ConnectionNeeded. Nothing for us to do.
        return direct
      }

      // Past here the default router has handed back a path LDK cannot use.
      if (introductionNode === null) {
        onUnroutable?.('introduction node SCID is not in the network graph', null)
        return Result_OnionMessagePathNoneZ.constructor_err()
      }
      if (lspNodeId === '') {
        onUnroutable?.('no LSP configured to relay through', introductionNode)
        return Result_OnionMessagePathNoneZ.constructor_err()
      }
      if (!peerHexes.includes(lspNodeId)) {
        onUnroutable?.('LSP is not a connected peer', introductionNode)
        return Result_OnionMessagePathNoneZ.constructor_err()
      }

      onRelay?.(introductionNode)
      return Result_OnionMessagePathNoneZ.constructor_ok(
        OnionMessagePath.constructor_new([hexToBytes(lspNodeId)], resolved, [])
      )
    },

    create_blinded_paths(recipient, local_node_receive_key, context, peers) {
      return inner.create_blinded_paths(recipient, local_node_receive_key, context, peers)
    },
  })
}
