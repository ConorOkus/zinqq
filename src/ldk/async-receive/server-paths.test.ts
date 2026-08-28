import { describe, it, expect, vi } from 'vitest'

// Mocked LDK. The blob under test is `u16 count || path || path ...`, and each
// mock "path" is a 3-byte record: [marker, 0xAA, 0xBB]. `constructor_read`
// consumes the first 3 bytes and ignores trailing data, mirroring the real
// binding's behaviour (verified against real WASM in handshake-harness.test.ts),
// and `write()` returns those 3 bytes so the caller can segment by round-trip.
//
// marker 0x01 -> introduces at NODE_A   0x02 -> NODE_B
// marker 0x03 -> compact node resolved via graph to NODE_A
// marker 0x04 -> compact node the graph cannot resolve
// marker 0xff -> fails to decode
const NODE_A = 'aa'.repeat(33)
const NODE_B = 'bb'.repeat(33)

vi.mock('lightningdevkit', () => {
  class Result_BlindedMessagePathDecodeErrorZ_OK {
    res: unknown
    constructor(res: unknown) {
      this.res = res
    }
  }
  class Result_BlindedMessagePathDecodeErrorZ_Err {}
  class IntroductionNode {}
  class IntroductionNode_NodeId extends IntroductionNode {
    node_id: Uint8Array
    constructor(node_id: Uint8Array) {
      super()
      this.node_id = node_id
    }
  }
  class IntroductionNode_DirectedShortChannelId extends IntroductionNode {}

  const hexToBytes = (hex: string) => {
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    return out
  }

  class FakePath {
    marker: number
    constructor(marker: number) {
      this.marker = marker
    }
    write() {
      return new Uint8Array([this.marker, 0xaa, 0xbb])
    }
    introduction_node() {
      if (this.marker === 0x01) return new IntroductionNode_NodeId(hexToBytes(NODE_A))
      if (this.marker === 0x02) return new IntroductionNode_NodeId(hexToBytes(NODE_B))
      return new IntroductionNode_DirectedShortChannelId()
    }
    public_introduction_node_id() {
      if (this.marker === 0x03) return { as_slice: () => hexToBytes(NODE_A) }
      return null
    }
  }

  class BlindedMessagePath {
    static constructor_read(ser: Uint8Array) {
      const marker = ser[0] ?? 0
      if (marker === 0xff || ser.length < 3) {
        return new Result_BlindedMessagePathDecodeErrorZ_Err()
      }
      return new Result_BlindedMessagePathDecodeErrorZ_OK(new FakePath(marker))
    }
  }

  return {
    BlindedMessagePath,
    IntroductionNode,
    IntroductionNode_NodeId,
    IntroductionNode_DirectedShortChannelId,
    Result_BlindedMessagePathDecodeErrorZ_OK,
    Result_BlindedMessagePathDecodeErrorZ_Err,
  }
})

const { decodeServerPaths, introductionNodeIdHex } = await import('./server-paths')
const ldk = (await import('lightningdevkit')) as unknown as Record<
  string,
  { constructor_read: (b: Uint8Array) => { res?: unknown } }
>

const graph = {} as never

/** Build `u16 count || 3-byte path records` from marker bytes. */
function blob(markers: number[], countOverride?: number): string {
  const count = countOverride ?? markers.length
  const bytes = [count >> 8, count & 0xff]
  for (const m of markers) bytes.push(m, 0xaa, 0xbb)
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function pathFor(marker: number) {
  const r = ldk.BlindedMessagePath!.constructor_read(new Uint8Array([marker, 0xaa, 0xbb]))
  return r.res as never
}

describe('introductionNodeIdHex', () => {
  it('reads an explicit introduction node id directly', () => {
    expect(introductionNodeIdHex(pathFor(0x01), graph)).toBe(NODE_A)
  })

  it('resolves a compact introduction node through the network graph', () => {
    expect(introductionNodeIdHex(pathFor(0x03), graph)).toBe(NODE_A)
  })

  it('returns null when a compact introduction node cannot be resolved', () => {
    expect(introductionNodeIdHex(pathFor(0x04), graph)).toBeNull()
  })
})

describe('decodeServerPaths', () => {
  it('decodes every path in the vector and pins each to the server node id', () => {
    const result = decodeServerPaths(blob([0x01, 0x01]), NODE_A, graph)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.paths).toHaveLength(2)
  })

  it('treats an empty setting as the feature being off', () => {
    expect(decodeServerPaths('', NODE_A, graph)).toEqual({ ok: true, paths: [] })
  })

  it('rejects a non-hex blob', () => {
    const result = decodeServerPaths('zzzz', NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not even-length lowercase hex')
  })

  it('rejects a blob too short to hold a length prefix', () => {
    const result = decodeServerPaths('00', NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('too short')
  })

  it('rejects a blob declaring zero paths', () => {
    const result = decodeServerPaths(blob([], 0), NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('zero paths')
  })

  it('rejects the extended length encoding rather than guessing at it', () => {
    const result = decodeServerPaths(blob([0x01], 0xffff), NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('extended length encoding')
  })

  it('rejects a blob that ends before the declared path count', () => {
    const result = decodeServerPaths(blob([0x01], 3), NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/ended before path|failed to decode/)
  })

  it('rejects trailing bytes after the declared paths', () => {
    const result = decodeServerPaths(blob([0x01, 0x01], 1), NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('trailing byte')
  })

  it('rejects the whole set when one path fails to decode', () => {
    const result = decodeServerPaths(blob([0x01, 0xff]), NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('path 1 failed to decode')
  })

  it('rejects the whole set when one path introduces at a different node', () => {
    const result = decodeServerPaths(blob([0x01, 0x02]), NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('expected')
  })

  it('rejects a path whose introduction node cannot be resolved', () => {
    const result = decodeServerPaths(blob([0x04]), NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('unresolvable introduction node')
  })

  it('does not return a partial path set on failure', () => {
    const result = decodeServerPaths(blob([0x01, 0x01, 0xff]), NODE_A, graph)
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('paths')
  })
})
