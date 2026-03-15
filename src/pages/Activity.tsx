export function Activity() {
  return (
    <div className="flex min-h-dvh flex-col bg-accent pb-(--spacing-tab-bar)">
      <div className="px-6 pt-6">
        <h1 className="font-display text-3xl font-bold text-on-accent">
          Activity
        </h1>
      </div>
      <div className="flex flex-1 items-center justify-center">
        <p className="text-[var(--color-on-accent-muted)]">
          No transactions yet
        </p>
      </div>
    </div>
  )
}
