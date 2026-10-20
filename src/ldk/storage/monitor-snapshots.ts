import type { ChannelMonitor } from 'lightningdevkit'
import { bytesToHex } from '../utils'

export interface MonitorSnapshot {
  key: string
  data: Uint8Array
  monitor: ChannelMonitor
}

export interface SelectedMonitorSnapshot extends MonitorSnapshot {
  aliases: string[]
}

/** Funding outpoints change during splicing; the logical channel identity does not. */
export function selectLatestMonitorSnapshots(
  snapshots: MonitorSnapshot[]
): SelectedMonitorSnapshot[] {
  const channels = new Map<string, MonitorSnapshot[]>()
  for (const snapshot of snapshots) {
    const channelId = bytesToHex(snapshot.monitor.channel_id().write())
    const group = channels.get(channelId) ?? []
    group.push(snapshot)
    channels.set(channelId, group)
  }
  return [...channels].map(([channelId, group]) => {
    const latest = group.reduce((a, b) =>
      a.monitor.get_latest_update_id() >= b.monitor.get_latest_update_id() ? a : b
    )
    const update = latest.monitor.get_latest_update_id()
    if (
      group.some(
        (snapshot) =>
          snapshot.monitor.get_latest_update_id() === update &&
          (snapshot.data.length !== latest.data.length ||
            !snapshot.data.every((byte, index) => byte === latest.data[index]))
      )
    ) {
      throw new Error(
        `Conflicting ChannelMonitor snapshots for channel ${channelId} at update ${update}. ` +
          'Preserving all records and refusing to choose between them.'
      )
    }
    return { ...latest, aliases: [...new Set(group.map((snapshot) => snapshot.key))] }
  })
}
