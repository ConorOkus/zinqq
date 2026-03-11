import { Logger, Level, type Record } from 'lightningdevkit'

export function createLogger(): Logger {
  return Logger.new_impl({
    log(record: Record): void {
      const level = record.get_level()
      const module = record.get_module_path()
      const message = record.get_args()
      const prefix = `[LDK ${module}]`

      switch (level) {
        case Level.LDKLevel_Gossip:
        case Level.LDKLevel_Trace:
          console.debug(prefix, message)
          break
        case Level.LDKLevel_Debug:
          console.debug(prefix, message)
          break
        case Level.LDKLevel_Info:
          console.info(prefix, message)
          break
        case Level.LDKLevel_Warn:
          console.warn(prefix, message)
          break
        case Level.LDKLevel_Error:
          console.error(prefix, message)
          break
      }
    },
  })
}
