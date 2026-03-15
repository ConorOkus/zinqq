import { ScreenHeader } from '../components/ScreenHeader'

export function Peers() {
  return (
    <div className="flex min-h-dvh flex-col bg-dark text-on-dark">
      <ScreenHeader title="Peers" backTo="/settings/advanced" />
      <div className="p-4">
        <p className="text-[var(--color-on-dark-muted)]">Coming soon</p>
      </div>
    </div>
  )
}
