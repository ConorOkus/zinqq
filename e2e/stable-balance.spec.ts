import { test, expect } from '@playwright/test'

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`stable balance settings at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.route('**/api/stable-price', (route) =>
      route.fulfill({ status: 503, json: { error: 'Markets unavailable' } })
    )
    await page.goto('/')
    const create = page.getByRole('button', { name: /create wallet/i })
    const settings = page.getByRole('button', { name: /settings menu/i })
    await expect(create.or(settings)).toBeVisible({ timeout: 20_000 })
    if (await create.isVisible()) {
      await create.click()
      await page.getByRole('button', { name: /i've written it down/i }).click()
    }
    await expect(page.getByRole('button', { name: /settings menu/i })).toBeVisible({
      timeout: 20_000,
    })
    await page.getByRole('button', { name: /settings menu/i }).click()
    await page.getByRole('button', { name: /stable balance/i }).click()
    await expect(page.getByRole('banner').getByText('Stable Balance')).toBeVisible()
    await expect(page.getByText('Not allocated', { exact: true })).toBeVisible()
    await expect(page.getByText('Acknowledged USD target')).toBeVisible()
    await expect(page.getByText(/Keep the wallet open and online/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirm USD target' })).toHaveCount(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await page.screenshot({ path: `/tmp/zinq-stable-${viewport.width}.png`, fullPage: true })
  })
}
