import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function ActionHelp({
  children,
  label,
  text,
}: {
  children: ReactNode
  label: string
  text: string
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div
      ref={container}
      className="relative flex items-center gap-1"
      onPointerLeave={() => {
        if (document.activeElement !== trigger.current) setOpen(false)
      }}
    >
      {children}
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--color-on-dark-muted)] hover:text-on-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="size-4"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6" />
          <circle cx="12" cy="7.5" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <div
          id={id}
          role="tooltip"
          className="absolute top-full left-0 z-20 w-full rounded-xl border border-on-dark/20 bg-dark-elevated p-3 text-xs leading-relaxed text-on-dark shadow-lg"
        >
          {text}
        </div>
      )}
    </div>
  )
}
