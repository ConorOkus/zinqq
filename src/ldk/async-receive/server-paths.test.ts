import { describe, it, expect, vi, beforeEach } from 'vitest'

// Every LDK-touching test in this repo mocks `lightningdevkit` — nothing here
// initializes real WASM (see src/ldk/sweep.test.ts for the same pattern).
// `constructor_read` is steered per-entry by the hex value: a 1-byte entry
// whose value is the marker.
//
// Marker 0x01 -> decodes, introduces at NODE_A (an explicit NodeId)
// Marker 0x02 -> decodes, introduces at NODE_B (an explicit NodeId)
// Marker 0x03 -> decodes, compact introduction node resolved via the graph
// Marker 0x04 -> decodes, compact introduction node the graph cannot resolve
// Marker 0xff -> fails to decode
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
    introduction_node() {
      if (this.marker === 0x01) return new IntroductionNode_NodeId(hexToBytes(NODE_A))
      if (this.marker === 0x02) return new IntroductionNode_NodeId(hexToBytes(NODE_B))
      return new IntroductionNode_DirectedShortChannelId()
    }
    public_introduction_node_id() {
      // 0x03 resolves through the graph to NODE_A; 0x04 resolves to nothing.
      if (this.marker === 0x03) return { as_slice: () => hexToBytes(NODE_A) }
      return null
    }
  }

  class BlindedMessagePath {
    static constructor_read(ser: Uint8Array) {
      const marker = ser[0] ?? 0
      if (marker === 0xff) return new Result_BlindedMessagePathDecodeErrorZ_Err()
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

const { splitServerPathEntries, decodeServerPaths, introductionNodeIdHex } =
  await import('./server-paths')
const { BlindedMessagePath, Result_BlindedMessagePathDecodeErrorZ_OK } =
  await import('lightningdevkit')

// The graph is only consulted for compact introduction nodes, and the mock
// resolves those from the marker, so a placeholder suffices.
const graph = {} as never

function pathFor(marker: string) {
  const result = BlindedMessagePath.constructor_read(new Uint8Array([Number.parseInt(marker, 16)]))
  expect(result).toBeInstanceOf(Result_BlindedMessagePathDecodeErrorZ_OK)
  return (result as unknown as { res: unknown }).res as never
}

describe('splitServerPathEntries', () => {
  it('returns no entries for an empty setting', () => {
    expect(splitServerPathEntries('')).toEqual([])
  })

  it('parses a single entry', () => {
    expect(splitServerPathEntries('01')).toEqual(['01'])
  })

  it('parses multiple entries in order, tolerating whitespace', () => {
    expect(splitServerPathEntries(' 01 , 02 ,03 ')).toEqual(['01', '02', '03'])
  })

  it('drops empty segments from trailing or doubled commas', () => {
    expect(splitServerPathEntries('01,,02,')).toEqual(['01', '02'])
  })
})

describe('introductionNodeIdHex', () => {
  it('reads an explicit introduction node id directly', () => {
    expect(introductionNodeIdHex(pathFor('01'), graph)).toBe(NODE_A)
  })

  it('resolves a compact introduction node through the network graph', () => {
    expect(introductionNodeIdHex(pathFor('03'), graph)).toBe(NODE_A)
  })

  it('returns null when a compact introduction node cannot be resolved', () => {
    expect(introductionNodeIdHex(pathFor('04'), graph)).toBeNull()
  })
})

describe('decodeServerPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts a set where every path introduces at the configured node id', () => {
    const result = decodeServerPaths(['01', '01'], NODE_A, graph)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.paths).toHaveLength(2)
  })

  it('accepts an empty entry list without consulting the decoder', () => {
    const result = decodeServerPaths([], NODE_A, graph)
    expect(result).toEqual({ ok: true, paths: [] })
  })

  it('rejects the whole set when one entry fails to decode', () => {
    const result = decodeServerPaths(['01', 'ff'], NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('path 1 failed to decode')
  })

  it('rejects the whole set when one path introduces at a different node', () => {
    const result = decodeServerPaths(['01', '02'], NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('expected')
  })

  it('rejects a path whose introduction node cannot be resolved', () => {
    const result = decodeServerPaths(['04'], NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('unresolvable introduction node')
  })

  it('rejects a non-hex entry before it reaches the decoder', () => {
    const result = decodeServerPaths(['zz'], NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not even-length lowercase hex')
  })

  it('rejects an odd-length entry before it reaches the decoder', () => {
    const result = decodeServerPaths(['abc'], NODE_A, graph)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not even-length lowercase hex')
  })

  it('does not return a partial path set on failure', () => {
    const result = decodeServerPaths(['01', '01', 'ff'], NODE_A, graph)
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('paths')
  })
})
