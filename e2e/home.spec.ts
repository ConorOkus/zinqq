import { test, expect } from '@playwright/test'

test('home page loads and displays heading', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /browser wallet/i })).toBeVisible()
})

test('navigation to settings works', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: /settings/i }).click()
  await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()
})
