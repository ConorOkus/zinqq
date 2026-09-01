import {
  BlindedMessagePath,
  IntroductionNode_NodeId,
  Result_BlindedMessagePathDecodeErrorZ_OK,
  type NodeId,
  type ReadOnlyNetworkGraph,
} from 'lightningdevkit'
import { bytesToHex } from '../utils'

/**
 * Decoding of the static invoice server's blinded message paths.
 *
 * The wire shape is hex of LDK's `Vec<BlindedMessagePath>::write()` — the whole
 * vector as one blob, with a length prefix — because that is what ldk-node's
 * uniffi bindings already emit and consume for async-recipient paths. Every
 * Swift/Kotlin ldk-node client speaks this form, so matching it means no
 * invented format. It is LDK's internal `Writeable` encoding rather than a BOLT
 * wire format, so in principle both ends must pin the same LDK revision; the
 * failure mode is a decode error at bootstrap, not corrupted persisted state.
 *
 * In practice the encoding has held across a revision gap: a blob written by
 * `lightning` 0.3.0+git read back here on 0.2.4-0 exactly — two paths, full
 * consumption, no trailing bytes. Reassuring rather than guaranteed, so the
 * decode error remains the contract.
 *
 * Kept out of `config.ts` because that module is imported by tests that never
 * initialize WASM.
 */
export type ServerPathsResult =
  | { ok: true; paths: BlindedMessagePath[] }
  | { ok: false; reason: string }

const HEX_BLOB = /^(?:[0-9a-f]{2})+$/

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Hex pubkey behind a `NodeId`, or null when the lookup found nothing.
 *
 * "Nothing" does not arrive as JS `null`. `public_introduction_node_id` always
 * hands back a `NodeId` object; for `None` that object wraps a null pointer,
 * and calling `as_slice()` on it yields 33 zero bytes — a value that reads as a
 * perfectly well-formed pubkey to anything checking only length. Verified
 * against real WASM: an unresolvable compact introduction node produces
 * `ptr: 0` and `"00".repeat(33)`.
 *
 * So the pointer is checked first, the same guard `nodeIdBytes` in
 * `onion/lsp-relay-router.ts` uses, with the all-zero slice rejected as well
 * because a caller that trusts this value routes a payment by it.
 */
function nodeIdHex(nodeId: NodeId): string | null {
  if (!nodeId || (nodeId as unknown as { ptr?: bigint }).ptr === 0n) return null
  const bytes = nodeId.as_slice()
  if (!bytes || bytes.length !== 33) return null
  if (bytes.every((byte) => byte === 0)) return null
  return bytesToHex(bytes)
}

/**
 * Resolve the hex node id a blinded path's introduction node points at.
 *
 * Paths built with a compact introduction node carry a directed short channel
 * id instead of a pubkey; those need the network graph to resolve. Returns null
 * when it cannot be resolved, which the caller treats as an unusable path
 * rather than a pass.
 */
export function introductionNodeIdHex(
  path: BlindedMessagePath,
  networkGraph: ReadOnlyNetworkGraph
): string | null {
  try {
    const introduction = path.introduction_node()
    if (introduction instanceof IntroductionNode_NodeId) {
      return bytesToHex(introduction.node_id)
    }

    return nodeIdHex(path.public_introduction_node_id(networkGraph))
  } catch {
    // An unresolvable compact introduction node can throw out of WASM. Treat
    // it as unresolvable, never as a pass.
    return null
  }
}

/**
 * Decode a hex-encoded `Vec<BlindedMessagePath>`.
 *
 * This deliberately does **not** check who the paths lead to, because that
 * cannot be checked. An earlier version required every path to introduce at a
 * configured server node id, on the assumption that a static invoice server's
 * paths introduce at the server. They do not: `blinded_paths_for_async_recipient`
 * builds paths introducing at the server's *peers*, since concealing the
 * destination is what a blinded path is for. Observed against a real ldk-server
 * — a two-path blob introducing at two different peers, neither of them the
 * server — so no single expected node id could ever have matched.
 *
 * What remains verifiable is structural: the framing is well-formed, every path
 * decodes, the blob is fully consumed, and each introduction node resolves to a
 * pubkey we could actually send to. Server identity rests on the integrity of
 * the build-time config, which is where the paths come from in the first place.
 *
 * There is no per-element length prefix, so the blob cannot be parsed by
 * skipping elements — each path must be fully decoded to find where the next
 * begins. That is a structural constraint of the encoding, not a shortcut here.
 *
 * Segmentation works because `constructor_read` consumes only the bytes one
 * path needs and tolerates trailing data, and re-serializing the decoded path
 * reproduces exactly those bytes — so the round-trip length is how far to
 * advance. Verified against real LDK in `handshake-harness.test.ts`.
 *
 * Fails the whole set on any bad entry: registering a subset would leave the
 * server holding paths the wallet does not think it granted.
 */
export function decodeServerPaths(
  blobHex: string,
  networkGraph: ReadOnlyNetworkGraph
): ServerPathsResult {
  const trimmed = blobHex.trim()
  if (trimmed === '') return { ok: true, paths: [] }
  if (!HEX_BLOB.test(trimmed)) {
    return { ok: false, reason: 'server paths blob is not even-length lowercase hex' }
  }

  const bytes = hexToBytes(trimmed)
  if (bytes.length < 2) {
    return { ok: false, reason: 'server paths blob is too short to contain a length prefix' }
  }

  // Framing confirmed against lightning 0.3.0+git rev 3dfcc4cc:
  // `impl_for_vec!(BlindedMessagePath)` (util/ser.rs:1162) uses the plain
  // variant — a CollectionLength followed by each element written directly,
  // with no per-element length prefix. CollectionLength (util/ser.rs:567-577)
  // is a big-endian u16 below 0xffff, escaping to an 0xffff marker followed by
  // a u64 of `len - 0xffff`.
  //
  // Reading only the u16 form is deliberate, not an oversight: the escape needs
  // 65,535+ paths, which is not a real input. Reject it loudly rather than
  // widening the parser for a case that would signal a malformed blob anyway.
  const count = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)
  if (count === 0xffff) {
    return {
      ok: false,
      reason: "server paths blob uses CollectionLength's extended (0xffff) encoding",
    }
  }
  if (count === 0) {
    return { ok: false, reason: 'server paths blob declares zero paths' }
  }

  const paths: BlindedMessagePath[] = []
  let offset = 2

  for (let index = 0; index < count; index++) {
    if (offset >= bytes.length) {
      return { ok: false, reason: `server paths blob ended before path ${index}` }
    }

    const result = BlindedMessagePath.constructor_read(bytes.slice(offset))
    if (!(result instanceof Result_BlindedMessagePathDecodeErrorZ_OK)) {
      return { ok: false, reason: `path ${index} failed to decode as a blinded message path` }
    }

    const path = result.res
    const consumed = path.write().length
    if (consumed === 0) {
      return { ok: false, reason: `path ${index} decoded to zero bytes` }
    }
    offset += consumed

    // An introduction node we cannot resolve is one we cannot send to, so the
    // path is useless regardless of who it belongs to.
    if (introductionNodeIdHex(path, networkGraph) === null) {
      return { ok: false, reason: `path ${index} has an unresolvable introduction node` }
    }

    paths.push(path)
  }

  if (offset !== bytes.length) {
    return {
      ok: false,
      reason: `server paths blob has ${bytes.length - offset} trailing byte(s) after ${count} path(s)`,
    }
  }

  return { ok: true, paths }
}
