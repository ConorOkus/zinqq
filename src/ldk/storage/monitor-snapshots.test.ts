import { describe, expect, it } from 'vitest'
import type { ChannelMonitor } from 'lightningdevkit'
import { selectLatestMonitorSnapshots, type MonitorSnapshot } from './monitor-snapshots'

function snapshot(
  key: string,
  update: bigint,
  channel = 1,
  data = Number(update)
): MonitorSnapshot {
  return {
    key,
    data: Uint8Array.of(data),
    monitor: {
      channel_id: () => ({ write: () => new Uint8Array(32).fill(channel) }),
      get_latest_update_id: () => update,
    } as unknown as ChannelMonitor,
  }
}

describe('spliced channel monitor recovery', () => {
  it.each([true, false])(
    'selects update 32 over the old funding snapshot at 21 (new first: %s)',
    (newFirst) => {
      const old = snapshot('old-funding:1', 21n)
      const current = snapshot('new-funding:0', 32n)
      const entries = newFirst ? [current, old] : [old, current]
      const selected = selectLatestMonitorSnapshots(entries)
      expect(selected).toHaveLength(1)
      expect(selected[0]!.monitor).toBe(current.monitor)
      expect(selected[0]!.key).toBe(current.key)
      expect(selected[0]!.aliases).toEqual(expect.arrayContaining([old.key, current.key]))
      expect(entries).toHaveLength(2)
    }
  )
  it('keeps separate channels even when their update ids differ', () => {
    expect(
      selectLatestMonitorSnapshots([snapshot('a:0', 21n), snapshot('b:0', 32n, 2)])
    ).toHaveLength(2)
  })
  it('refuses conflicting records at the same update id', () => {
    expect(() =>
      selectLatestMonitorSnapshots([snapshot('a:0', 32n, 1, 1), snapshot('b:0', 32n, 1, 2)])
    ).toThrow(/Conflicting ChannelMonitor snapshots/)
  })
  it('ignores conflicting obsolete snapshots when a newer complete snapshot exists', () => {
    const selected = selectLatestMonitorSnapshots([
      snapshot('a:0', 21n, 1, 1),
      snapshot('b:0', 21n, 1, 2),
      snapshot('c:0', 32n),
    ])
    expect(selected[0]!.key).toBe('c:0')
  })
  it('deduplicates identical records at the same update without dropping their aliases', () => {
    const selected = selectLatestMonitorSnapshots([snapshot('a:0', 32n), snapshot('b:0', 32n)])
    expect(selected).toHaveLength(1)
    expect(selected[0]!.aliases).toEqual(['a:0', 'b:0'])
  })
})
