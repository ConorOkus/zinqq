---
title: "BottomSheet accessibility: focus trap, scroll lock, and related PR fixes"
category: ui-bugs
date: 2026-03-31
tags:
  - accessibility
  - focus-trap
  - scroll-lock
  - bottom-sheet
  - react
  - typescript-strict
modules:
  - src/components/BottomSheet.tsx
  - src/pages/Receive.tsx
  - src/pages/Receive.test.tsx
severity: moderate
symptoms:
  - Tab key escapes BottomSheet modal into background content
  - Page behind backdrop scrollable on touch devices when sheet is open
  - TypeScript strict mode error on querySelectorAll indexed access returning T | undefined
root_cause: >
  The BottomSheet component declared role="dialog" and aria-modal="true" but
  did not implement the behavioral requirements those attributes imply: focus
  trapping and body scroll locking. This is a common gap in hand-rolled dialog
  components where ARIA attributes are easy to add but the companion JavaScript
  behaviors are overlooked.
---

# BottomSheet Accessibility: Focus Trap, Scroll Lock, and TypeScript Strict Indexing

## Problem

When a component declares `role="dialog"` and `aria-modal="true"`, assistive technologies and browser semantics expect two behavioral guarantees:

1. **Focus trap** -- keyboard focus must not escape the dialog. Without it, Tab moves focus to elements behind the backdrop, breaking the modal contract.
2. **Body scroll lock** -- the page behind the overlay must not scroll. On mobile, touching the backdrop causes the underlying page to scroll.

The initial `BottomSheet` implementation had the ARIA attributes but neither behavior.

## Root Cause

The component rendered correct ARIA semantics (`role="dialog"`, `aria-modal="true"`, Escape key handling, backdrop click) but omitted the two mandatory companion behaviors. This is the worst kind of accessibility bug -- the component lies to assistive technologies, which trust the declared semantics.

## Solution

All logic lives in a single `useEffect` gated on the `open` state, with cleanup in the return function.

### Focus trap via Tab key interception

The handler intercepts Tab, queries focusable elements within the sheet, and wraps focus at the boundaries:

```typescript
if (e.key === 'Tab') {
  const sheet = sheetRef.current
  if (!sheet) return
  const focusable = sheet.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}
```

### Scroll lock via `document.body.style.overflow`

Set on open, cleared on cleanup:

```typescript
document.body.style.overflow = 'hidden'
document.addEventListener('keydown', handleKeyDown)
return () => {
  document.removeEventListener('keydown', handleKeyDown)
  document.body.style.overflow = ''
}
```

Setting `overflow` to the empty string removes the inline style entirely, restoring whatever CSS was previously in effect.

### Initial focus

A separate `useEffect` moves focus to the sheet on open:

```typescript
useEffect(() => {
  if (open) sheetRef.current?.focus()
}, [open])
```

The sheet div has `tabIndex={-1}` and `outline-none`, making it programmatically focusable without a visible ring.

## TypeScript Gotcha: `querySelectorAll` Indexing

`querySelectorAll` returns a `NodeListOf<HTMLElement>`. Indexing with `[0]` or `[length - 1]` returns `HTMLElement | undefined` in strict mode. TypeScript does not narrow NodeList types based on length guards -- the check and the access are separate statements.

```typescript
// BAD -- no TS error but fragile
if (focusable.length > 0) {
  focusable[0].focus()
}

// GOOD -- explicit null guard
const first = focusable[0]
if (!first) return
first.focus()
```

Consider enabling `noUncheckedIndexedAccess` in `tsconfig.json` to enforce this project-wide.

## Prevention

### Modal/dialog component checklist

Every `role="dialog"` component must have:

- [ ] Focus trap (Tab/Shift+Tab cycle within the dialog)
- [ ] Body scroll lock (`overflow: hidden` on body while open)
- [ ] Escape key dismissal
- [ ] Backdrop click dismissal
- [ ] ARIA attributes (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`)
- [ ] Initial focus placement inside the dialog
- [ ] Focus restoration on close (return focus to the trigger element)
- [ ] Cleanup of all listeners and DOM mutations in `useEffect` return

### Review heuristic

> If you see `role="dialog"` or `aria-modal="true"` in JSX, immediately check for focus trap and scroll lock. If either is absent, flag the PR.

### Testing focus traps in vitest/jsdom

jsdom does not implement tab order, so `fireEvent.keyDown(el, { key: 'Tab' })` won't move `document.activeElement`. Instead, test the trap handler directly:

```typescript
it('wraps focus from last to first element on Tab', () => {
  render(<BottomSheet open={true} onClose={jest.fn()}><button>Copy</button></BottomSheet>)
  const copyButton = screen.getByRole('button', { name: /copy/i })
  copyButton.focus()
  fireEvent.keyDown(copyButton, { key: 'Tab', shiftKey: false })
  // Assert your handler redirected focus
})
```

For true tab-order verification, use Playwright end-to-end tests.

## Related Documents

- [LSPS2 JIT Receive: useEffect dependency race](../integration-issues/lsps2-jit-receive-react-effect-dependencies.md) -- useEffect cleanup patterns on the same Receive page
- [LSPS2 JIT Receive: channel config](../integration-issues/lsps2-jit-receive-channel-config.md) -- Receive page context

## References

- PR: ConorOkus/zinqq#73
- WAI-ARIA Dialog Pattern: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
