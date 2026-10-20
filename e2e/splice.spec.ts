import { test, expect } from '@playwright/test'

test.use({ hasTouch: true })

// This fixture cannot sign or broadcast. Funding/signing use actual BDK and
// LDK bindings in src/stable/splice*.test.ts.
const fixture = `
export * from '/src/stable/runtime.ts?original=1';
import { PUBLIC_STABLE_PROVIDER } from '/src/stable/runtime.ts?original=1';
const listeners = new Set();
const controller = {
  state: null, error: null,
  subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  quote: async amount => ({ amountSats: String(amount), maxFeeSats: '600', feeRate: 2 }),
  quoteMaximum: async () => ({ amountSats: '59400', maxFeeSats: '600', feeRate: 2 }),
  commit: async quote => {
    window.__spliceCommits = (window.__spliceCommits || 0) + 1;
    controller.state = { status: 'pending', signedTx: '00', quote };
    listeners.forEach(fn => fn());
  },
};
const tradeQuote = targetCents => ({
  targetCents, feeSats: 1960n, backingSats: 198040n,
  baseline: 1, channelId: 'a'.repeat(64), price: { priceCents: 10000000n },
});
const runtime = { provider: PUBLIC_STABLE_PROVIDER, splice: controller, client: {
  refresh: async () => {},
  quoteMaximum: () => tradeQuote(19804n),
  quote: tradeQuote,
  commit: async () => { window.__usdCommits = (window.__usdCommits || 0) + 1; },
} };
const snapshot = {
  state: { enabled: true, pending: null, inbox: [], position: { channelId: 'a'.repeat(64), targetUsd: 4, backingSats: '4000' } },
  channel: { channelId: 'a'.repeat(64), receiverSats: 200000n, spendableSats: 200000n, usable: true },
  priceFresh: true, price: { priceCents: 10000000n }, status: 'Active', error: null, busy: false,
};
export const getStableRuntime = () => runtime;
export const getStableSnapshot = () => snapshot;
export const subscribeStable = () => () => {};
`

for (const width of [390, 1280]) {
  test(`current-value USD target at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/src/stable/runtime.ts*', (route) =>
      new URL(route.request().url()).searchParams.has('original')
        ? route.continue()
        : route.fulfill({ contentType: 'application/javascript', body: fixture })
    )
    await page.goto('/settings/stable-balance')
    const panel = page.getByRole('region', { name: 'Allocate USD' })
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByText(/Fills the maximum USD target/)).toHaveCount(0)
    const help = panel.getByRole('button', { name: 'About current value' })
    await help.focus()
    await expect(panel.getByRole('tooltip')).toContainText('after the 1% conversion fee')
    await panel.screenshot({ path: `/tmp/zinq-current-value-tooltip-${width}.png` })
    await page.keyboard.press('Escape')
    await expect(panel.getByRole('tooltip')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Use current value ($198.04)' }).click()
    await expect(panel.getByLabel('USD target')).toHaveValue('198.04')
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__usdCommits)
    ).toBeUndefined()
    await expect(page.getByRole('button', { name: 'Confirm USD target' })).toHaveCount(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await panel.screenshot({ path: `/tmp/zinq-current-value-${width}.png` })
    await panel.getByRole('button', { name: 'Review USD target' }).click()
    await expect(page.getByText('New USD target: $198.04')).toBeVisible()
    await expect(page.getByText('Trade fee: ₿1,960')).toBeVisible()
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__usdCommits)
    ).toBeUndefined()
    await page.getByRole('button', { name: 'Confirm USD target' }).click()
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__usdCommits)
    ).toBe(1)
  })
  test(`mainnet add-funds review at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/src/stable/runtime.ts*', (route) =>
      new URL(route.request().url()).searchParams.has('original')
        ? route.continue()
        : route.fulfill({ contentType: 'application/javascript', body: fixture })
    )
    await page.goto('/settings/stable-balance')
    const panel = page.getByRole('region', { name: 'Add on-chain funds' })
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByRole('heading', { name: 'Add funds', exact: true })).toBeVisible()
    await expect(panel.getByText(/Maximum uses confirmed funds/)).toHaveCount(0)
    const help = panel.getByRole('button', { name: 'About maximum amount' })
    if (width === 390) await help.tap()
    else await help.hover()
    await expect(panel.getByRole('tooltip')).toContainText('10,000-sat on-chain safety reserve')
    await panel.screenshot({ path: `/tmp/zinq-maximum-tooltip-${width}.png` })
    await panel.getByRole('heading', { name: 'Add funds', exact: true }).click()
    await expect(panel.getByRole('tooltip')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Use maximum' }).click()
    await expect(panel.getByLabel('Amount', { exact: true })).toHaveValue('59400')
    await expect(panel.getByRole('button', { name: 'Confirm add funds' })).toHaveCount(0)
    // A custom amount can still replace the suggested maximum.
    if (width === 1280) await panel.getByLabel('Amount', { exact: true }).fill('40000')
    await panel.getByRole('button', { name: 'Review', exact: true }).click()
    await expect(panel.getByText(`Adding: ${width === 390 ? '₿59,400' : '₿40,000'}`)).toBeVisible()
    await expect(panel.getByText('Maximum mining fee: ₿600')).toBeVisible()
    await expect(
      panel.getByText('At least 10,000 sats stays on-chain as a safety reserve.')
    ).toBeVisible()
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__spliceCommits)
    ).toBeUndefined()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await panel.screenshot({ path: `/tmp/zinq-mainnet-splice-${width}.png` })
    await panel.getByRole('button', { name: 'Confirm add funds' }).click()
    await expect(panel.getByRole('status')).toHaveText('Adding funds · waiting for confirmation')
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__spliceCommits)
    ).toBe(1)
    await expect(panel.getByRole('button', { name: 'Confirm add funds' })).toHaveCount(0)
  })
}
