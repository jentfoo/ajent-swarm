import { expect, test, type Page } from '@playwright/test'

// One turn through the UI end to end: the harness (scripts/e2e.sh) builds
// ajent and swarm, starts the fake provider and the service, and hands the
// coordinates over through environment variables.
//
//   SWARM_URL       service base URL
//   SWARM_USER      unix username the service runs as
//   SWARM_PASSWORD  seeded login password
//   SWARM_WORKSPACE directory to launch the session in

const url = process.env.SWARM_URL ?? 'http://127.0.0.1:8382'
const user = process.env.SWARM_USER ?? 'runner'
const password = process.env.SWARM_PASSWORD ?? 'smoke-secret'
const workspace = process.env.SWARM_WORKSPACE ?? '/tmp/smoke-ws'

test.describe.configure({ mode: 'serial' })

// signIn brings one fresh page past the login gate into the sessions grid.
async function signIn(page: Page) {
  await page.goto(url)
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('link', { name: 'Sessions' }).click()
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible()
}

test('login reaches the sessions screen', async ({ page }) => {
  await signIn(page)
})

test('launch a session and drive one turn', async ({ page }) => {
  await signIn(page)

  await page.getByRole('button', { name: 'Launch session' }).click()
  await page.getByLabel('Directory path').fill(workspace)
  await page.getByRole('button', { name: 'Launch' }).click()

  // the view navigates to /s/<id> once the child serves
  await expect(page).toHaveURL(/\/s\//, { timeout: 30_000 })
  const sessionId = page.url().split('/s/')[1]!
  expect(sessionId).not.toBe('')

  // the fleet attaches and the composer goes live; anchor on role so the
  // Queue button's aria-label cannot collide with substring matching
  const prompt = page.getByRole('textbox', { name: 'Prompt' })
  await expect(prompt).toBeEnabled({ timeout: 30_000 })

  await prompt.fill('Say the smoke test phrase.')
  await prompt.press('Enter')

  // the provider's streamed reply commits and renders
  await expect(page.getByText('The smoke test reply.')).toBeVisible({ timeout: 30_000 })
})

test('the session card reports online with the reply visible after reload', async ({ page }) => {
  await signIn(page)

  const card = page.locator('.grid .card').first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.getByText('online')).toBeVisible()
  await expect(card.getByText('swarm', { exact: true })).toBeVisible()

  // the committed history survives a fresh subscription
  await card.getByRole('link', { name: 'Open' }).click()
  await expect(page.getByText('The smoke test reply.')).toBeVisible({ timeout: 30_000 })
})

test('the job editor keeps its action footer visible while the form scrolls', async ({ page }) => {
  // jsdom cannot lay out the sticky split, so this pins the real thing at
  // both the desktop card and its inner scroll body
  await signIn(page)
  await page.goto(`${url}/jobs/new`)

  const modal = page.locator('.modal.job-editor')
  const scroll = modal.locator('.editor-scroll')
  const actions = modal.locator('.editor-actions')
  await expect(scroll).toBeVisible()

  // the card never scrolls itself; the body owns overflow
  await expect(modal).toHaveCSS('overflow-y', 'hidden')
  await expect(scroll).toHaveCSS('overflow-y', 'auto')

  // a short viewport guarantees the capped card overflows, then the footer
  // still sits fully inside it instead of scrolling away with the fields
  await page.setViewportSize({ width: 900, height: 480 })
  expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const box = await actions.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y + box!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight))

  // and the save action still works from that always-visible footer
  await page.getByRole('textbox', { name: /^Name/ }).fill('e2e-sticky')
  await page.getByLabel(/Workspace directory/).fill(workspace)
  await page.getByRole('button', { name: 'Create job' }).click()
  await expect(page.getByText('Job “e2e-sticky” saved.')).toBeVisible({ timeout: 15_000 })
})

test('reduced motion leaves overlay entrances at zero duration', async ({ page }) => {
  // Playwright emulates the media feature before any stylesheet loads, so the
  // reduced-motion block is in force from the first paint
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await signIn(page)

  const card = page.locator('.grid .card').first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: /^Rename/ }).click()

  // the shared modal shell: backdrop and card both carry enter keyframes, and
  // under the preference they resolve to zero duration instead of animating
  const backdrop = page.locator('.modal-backdrop')
  await expect(backdrop).toBeVisible()
  await expect(backdrop).toHaveCSS('animation-name', 'fade-in')
  await expect(backdrop).toHaveCSS('animation-duration', '0s')
  const modal = page.locator('.modal-backdrop .modal')
  await expect(modal).toHaveCSS('animation-name', 'modal-card-in')
  await expect(modal).toHaveCSS('animation-duration', '0s')
})
