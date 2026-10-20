/** Return false until a financial event has been durably processed. LDK retains it for replay. */
export function createStableEventGate(onError: (error: unknown) => void) {
  const pending = new Map<string, 'pending' | 'done'>()
  return (key: string, work: () => void | Promise<void>): boolean => {
    const status = pending.get(key)
    if (status === 'done') {
      pending.delete(key)
      return true
    }
    if (status === 'pending') return false
    try {
      const result = work()
      if (!result) return true
      pending.set(key, 'pending')
      void result.then(
        () => {
          pending.set(key, 'done')
        },
        (error: unknown) => {
          pending.delete(key)
          onError(error)
        }
      )
    } catch (error) {
      onError(error)
    }
    return false
  }
}
