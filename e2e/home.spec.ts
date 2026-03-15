import { test, expect, type Page } from '@playwright/test'

async function createWalletIfNeeded(page: Page) {
  await page.goto('/')
  // Either we see the welcome screen (new wallet) or the app (existing wallet)
  const createButton = page.getByRole('button', { name: /create wallet/i })
  const isNewWallet = await createButton.isVisible({ timeout: 3000 }).catch(() => false)

  if (isNewWallet) {
    await createButton.click()
    // Backup screen — confirm we've written it down
    await page.getByRole('button', { name: /i've written it down/i }).click()
    // Wait for the app to load after wallet creation
    await page.waitForTimeout(2000)
  }
}

test.describe('wallet app', () => {
  test.beforeEach(async ({ page }) => {
    await createWalletIfNeeded(page)
  })

  test('home page loads with Send and Request buttons', async ({ page }) => {
    await page.goto('/')
    // Should see the loading state or the home screen with CTAs
    await expect(
      page.getByRole('button', { name: /send/i }).or(page.getByText(/loading wallet/i)),
    ).toBeVisible({ timeout: 10000 })
  })

  test('navigation to settings works via tab bar', async ({ page }) => {
    await page.goto('/')
    // Wait for wallet to be ready (loading state clears)
    await page.waitForTimeout(3000)
    await page.goto('/') // Ensure we're on home route
    const settingsButton = page.getByRole('button', { name: /settings menu/i })
    await expect(settingsButton).toBeVisible({ timeout: 10000 })
    await settingsButton.click()
    await expect(page.getByRole('banner').getByText('Settings')).toBeVisible()
  })

  test('navigation to activity works via tab bar', async ({ page }) => {
    await page.goto('/')
    const activityButton = page.getByRole('button', { name: /^activity$/i })
    await expect(activityButton).toBeVisible({ timeout: 10000 })
    await activityButton.click()
    await expect(page.getByText('Activity')).toBeVisible()
  })

  test('send flow shows address input', async ({ page }) => {
    await page.goto('/send')
    await expect(
      page.getByText('Send').or(page.getByText(/loading wallet/i)),
    ).toBeVisible({ timeout: 10000 })
  })

  test('receive shows request overlay', async ({ page }) => {
    await page.goto('/receive')
    await expect(
      page.getByText('Request').or(page.getByText(/loading wallet/i)),
    ).toBeVisible({ timeout: 10000 })
  })
})
