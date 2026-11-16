import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Screenshot pass for the README, riding the same harness as the smoke suite
// (scripts/e2e.sh). Runs only when SWARM_SHOTS names an output directory:
//   SWARM_SHOTS=docs/img make test-e2e
const outDir = process.env.SWARM_SHOTS ?? ''

const url = process.env.SWARM_URL ?? 'http://127.0.0.1:8382'
const user = process.env.SWARM_USER ?? 'runner'
const password = process.env.SWARM_PASSWORD ?? 'smoke-secret'
const workspace = process.env.SWARM_WORKSPACE ?? '/tmp/smoke-ws'

test.skip(outDir === '', 'set SWARM_SHOTS to a directory to capture screenshots')

// signIn brings one page past the login gate, tolerating an existing session,
// and lands on the sessions grid.
async function signIn(page: Page) {
  await page.goto(url)
  const loginForm = page.getByLabel('Username')
  const signedIn = page.getByRole('button', { name: 'Sign out' })
  await loginForm.or(signedIn).waitFor()
  if (await loginForm.isVisible()) {
    await loginForm.fill(user)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await signedIn.waitFor()
  }
  await page.getByRole('link', { name: 'Sessions' }).click()
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible()
}

async function launchAndTurn(page: Page, phrase: string): Promise<string> {
  await page.getByRole('button', { name: 'Launch session' }).click()
  await page.getByLabel('Directory path').fill(workspace)
  await page.getByRole('button', { name: 'Launch' }).click()
  await expect(page).toHaveURL(/\/s\//, { timeout: 30_000 })
  const sessionId = page.url().split('/s/')[1]!

  const prompt = page.getByLabel('Prompt')
  await expect(prompt).toBeEnabled({ timeout: 30_000 })
  await prompt.fill(phrase)
  await prompt.press('Enter')
  await expect(page.getByText('The smoke test reply.')).toBeVisible({ timeout: 30_000 })
  return sessionId
}

test('capture desktop tiling and mobile session', async ({ page, browser }) => {
  test.setTimeout(180_000) // two launches, a split and a mobile pass
  fs.mkdirSync(outDir, { recursive: true })

  await signIn(page)
  await launchAndTurn(page, 'First pane.')
  await signIn(page)

  // desktop tiling: from the workspace home, the Tile press tiles every live
  // session into its own pane (the switcher only renders on workspace routes)
  await launchAndTurn(page, 'Second pane.')
  await page.getByRole('link', { name: 'Workspace' }).click()

  await page.getByRole('button', { name: 'Tile' }).click()
  await expect(page.getByText('First pane.')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Second pane.')).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(800) // let the panes settle
  await page.screenshot({ path: path.join(outDir, 'desktop-tiling.png'), fullPage: false })

  // mobile: single session view at phone width
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const mobile = await phone.newPage()
  await mobile.goto(url)
  await mobile.getByLabel('Username').fill(user)
  await mobile.getByLabel('Password').fill(password)
  await mobile.getByRole('button', { name: 'Sign in' }).click()
  await expect(mobile.getByRole('region', { name: 'Live sessions' })).toBeVisible({
    timeout: 30_000,
  })
  // rows open by tap; the sheet lists every known session
  await mobile.locator('[data-session-id]').first().click()
  await expect(mobile.getByText('The smoke test reply.').first()).toBeVisible({
    timeout: 30_000,
  })
  await mobile.waitForTimeout(300)
  await mobile.screenshot({ path: path.join(outDir, 'mobile-session.png'), fullPage: false })
  await phone.close()
})
