import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { createServer } from 'vite'

test('reloads the page before replacing a live LDK runtime', async ({ browser }) => {
  test.setTimeout(60_000)
  // An independent server and origin keep this test away from a funded wallet
  // and let us emit an update without editing any source files.
  const server = await createServer({
    server: { host: '127.0.0.1', port: 0, watch: null },
  })
  const context = await browser.newContext()
  try {
    await server.listen()
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('Test server did not publish a local URL')
    await page.goto(url)
    await page.waitForFunction(
      () => !!(window as unknown as Record<string, unknown>).__ldkNode,
      null,
      { timeout: 30_000 }
    )
    await page.evaluate(() => {
      ;(window as unknown as Record<string, unknown>).__hmrDocument = true
    })

    // Stable math is also imported by the UI, exercising multiple HMR paths
    // into the runtime rather than only a direct edit to the initializer.
    server.watcher.emit('change', resolve('src/stable/math.ts'))

    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as Record<string, unknown>).__hmrDocument),
        { timeout: 10_000 }
      )
      .toBeUndefined()
    await page.waitForFunction(
      () => !!(window as unknown as Record<string, unknown>).__ldkNode,
      null,
      { timeout: 30_000 }
    )
    expect(errors).toEqual([])
  } finally {
    await context.close()
    await server.close()
  }
})
