import { test, expect, type BrowserContext, type Page } from '@playwright/test'

/**
 * VSS Recovery E2E Test
 *
 * Tests the full create → backup → restore flow across two isolated browser
 * contexts (simulating two different browsers/devices).
 *
 * Context A: Creates a fresh wallet, waits for LDK init, captures mnemonic.
 * Context B: Restores wallet using the captured mnemonic, verifies recovery.
 */

const BASE_URL = 'http://localhost:5173'

/** Wait for the home screen to be fully loaded (Send + Request buttons visible). */
async function waitForHomeReady(page: Page) {
  await expect(page.getByRole('button', { name: /send/i })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: /request/i })).toBeVisible({ timeout: 5_000 })
}

/** Wait for LDK to finish initializing by checking console logs. Returns when CM is created/restored. */
async function waitForLdkInit(page: Page): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('LDK init did not complete within 30s'))
    }, 30_000)

    page.on('console', (msg) => {
      const text = msg.text()
      if (
        text.includes('Created fresh ChannelManager') ||
        text.includes('Restored ChannelManager from IDB') ||
        text.includes('discarding stale CM and creating fresh')
      ) {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
}

/** Get the node ID from the LDK dev window object. */
async function getNodeId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const node = (window as unknown as Record<string, unknown>).__ldkNode as
      | { nodeId?: string }
      | undefined
    return node?.nodeId ?? null
  })
}

/** Collect console errors related to key mismatches during page load. */
function collectKeyErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('Key that was generated does not match')) {
      errors.push(text)
    }
    if (text.includes('does not match the existing key')) {
      errors.push(text)
    }
  })
  return errors
}

/** Navigate to backup page and extract the 12-word mnemonic. */
async function captureMnemonic(page: Page): Promise<string> {
  await page.goto(`${BASE_URL}/settings/backup`)
  await expect(page.getByText('Wallet Backup')).toBeVisible({ timeout: 5_000 })

  // Click reveal button
  await page.getByRole('button', { name: /reveal seed phrase/i }).click()

  // Wait for the mnemonic grid to appear
  await expect(page.getByText(/write down these 12 words/i)).toBeVisible({ timeout: 5_000 })

  // Extract words from the MnemonicWordGrid component.
  // Structure: div.grid > div.font-mono > span (number) + span (word)
  // The word is the second span inside each grid cell.
  const gridCells = page.locator('.grid .font-mono')
  const count = await gridCells.count()
  const words: string[] = []
  for (let i = 0; i < count; i++) {
    // Second span in each cell is the word (first is the number label)
    const word = await gridCells.nth(i).locator('span').nth(1).textContent()
    if (word) words.push(word.trim())
  }

  if (words.length !== 12) {
    throw new Error(`Expected 12 mnemonic words, got ${words.length}: ${JSON.stringify(words)}`)
  }

  return words.join(' ')
}

/** Restore a wallet by entering the mnemonic on the restore page. */
async function restoreWallet(page: Page, mnemonic: string) {
  await page.goto(`${BASE_URL}/settings/restore`)
  await expect(page.getByText('Recover Wallet')).toBeVisible({ timeout: 10_000 })

  // Paste the full mnemonic into the first input field
  const firstInput = page.locator('input[type="text"]').first()
  await firstInput.fill(mnemonic)

  // Click Continue
  await page.getByRole('button', { name: /continue/i }).click()

  // Confirm the restore (the "Erase & Restore" warning screen)
  await expect(page.getByText(/this will replace your current wallet/i)).toBeVisible({
    timeout: 5_000,
  })
  await page.getByRole('button', { name: /erase & restore/i }).click()

  // Wait for either the page to reload (success) or an error message
  const errorText = page.getByText(/no backup found|restore failed/i)

  const result = await Promise.race([
    // The restore completes with an immediate page reload to '/'
    page.waitForURL('**/', { timeout: 30_000 }).then(() => 'success' as const),
    errorText.waitFor({ timeout: 30_000 }).then(() => 'error' as const),
  ])

  if (result === 'error') {
    const errorMessage = await page.locator('.text-red-400').textContent()
    throw new Error(`Restore failed: ${errorMessage}`)
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('VSS recovery', () => {
  let contextA: BrowserContext
  let contextB: BrowserContext
  let mnemonic: string

  test.beforeAll(async ({ browser }) => {
    // Create two isolated browser contexts (simulating different browsers)
    contextA = await browser.newContext()
    contextB = await browser.newContext()
  })

  test.afterAll(async () => {
    await contextA.close()
    await contextB.close()
  })

  test('create wallet in context A and capture mnemonic', async () => {
    const page = await contextA.newPage()

    // Start listening for LDK init before navigating
    const ldkReady = waitForLdkInit(page)

    // Navigate to home — wallet auto-creates on first visit
    await page.goto(BASE_URL)
    await waitForHomeReady(page)
    await ldkReady

    const nodeId = await getNodeId(page)
    console.log(`[Test] Context A node ID: ${nodeId}`)

    // Wait for VSS writes to settle
    await page.waitForTimeout(5_000)

    // Capture the mnemonic from the backup page
    mnemonic = await captureMnemonic(page)
    expect(mnemonic.split(' ')).toHaveLength(12)
    console.log(`[Test] Captured mnemonic (first word): ${mnemonic.split(' ')[0]}...`)

    await page.close()
  })

  test('restore wallet in context B using mnemonic', async () => {
    test.setTimeout(60_000)

    const page = await contextB.newPage()

    // Collect key mismatch errors across the entire test
    const keyErrors = collectKeyErrors(page)

    // First, let context B auto-create its own wallet so the app is functional
    const ldkReady = waitForLdkInit(page)
    await page.goto(BASE_URL)
    await waitForHomeReady(page)
    await ldkReady

    // Now navigate to restore and enter context A's mnemonic
    // restoreWallet waits for the page reload internally
    await restoreWallet(page, mnemonic)

    const ldkReadyAfterRestore = waitForLdkInit(page)
    await waitForHomeReady(page)
    await ldkReadyAfterRestore

    const restoredNodeId = await getNodeId(page)
    console.log(`[Test] Context B restored node ID: ${restoredNodeId}`)

    // Verify no key mismatch errors occurred during restore + re-init
    expect(keyErrors).toHaveLength(0)

    await page.close()
  })

  test('node IDs match between create and restore', async () => {
    // Re-open both contexts and compare node IDs
    const pageA = await contextA.newPage()
    const ldkA = waitForLdkInit(pageA)
    await pageA.goto(BASE_URL)
    await waitForHomeReady(pageA)
    await ldkA
    const idA = await getNodeId(pageA)

    const pageB = await contextB.newPage()
    const ldkB = waitForLdkInit(pageB)
    await pageB.goto(BASE_URL)
    await waitForHomeReady(pageB)
    await ldkB
    const idB = await getNodeId(pageB)

    console.log(`[Test] Context A node ID: ${idA}`)
    console.log(`[Test] Context B node ID: ${idB}`)

    expect(idA).toBeTruthy()
    expect(idB).toBeTruthy()
    expect(idA).toBe(idB)

    await pageA.close()
    await pageB.close()
  })
})
