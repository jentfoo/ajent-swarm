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

  // the provider's streamed reply commits and renders; exact keeps the
  // turn-end status line, which quotes the same reply, out of the match
  await expect(page.getByText('The smoke test reply.', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
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

test('the phone session fits its width through a waiting dialog', async ({ browser }) => {
  // jsdom lays nothing out, so the wrap and the room the dialog takes are
  // pinned on the real sheet at the 320px floor
  const phone = await browser.newContext({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await phone.newPage()
  try {
    await page.goto(url)
    await page.getByLabel('Username').fill(user)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('region', { name: 'Live sessions' })).toBeVisible({
      timeout: 30_000,
    })

    // the session the earlier turn launched opens by tap, like every row
    await page.locator('[data-session-id]').first().click()
    await expect(page).toHaveURL(/\/s\//, { timeout: 30_000 })
    const prompt = page.getByRole('textbox', { name: 'Prompt' })
    await expect(prompt).toBeEnabled({ timeout: 30_000 })

    // nothing pans sideways: the scrolling host's content stays inside its
    // box, the page inside the viewport, and the status bar inside its own box
    const fitsWidth = () =>
      page.evaluate(() => {
        const content = document.querySelector('.mobile-content') as HTMLElement
        const bar = document.querySelector('.status-bar')
        return (
          content.scrollWidth <= content.clientWidth &&
          document.documentElement.scrollWidth <= window.innerWidth &&
          (bar === null || bar.scrollWidth <= bar.clientWidth)
        )
      })
    expect(await fitsWidth()).toBe(true)

    // the fake session reports a short bar, so seed a realistic one: more
    // chips than a 320px row holds must wrap onto a second line, never widen
    // the bar or the page
    await page.evaluate(() => {
      const bar = document.querySelector('.status-bar')!
      for (const text of [
        'context 120k',
        'agents 2 active · 5 total · 3 done',
        '3 queued',
        '14 turns',
        'auto+write',
      ]) {
        const chip = document.createElement('span')
        chip.className = 'badge'
        chip.textContent = text
        bar.appendChild(chip)
      }
    })
    expect(await fitsWidth()).toBe(true)
    const wrappedBelow = await page.evaluate(() => {
      const bar = document.querySelector('.status-bar')!
      const lead = bar.querySelector('.spinner')!.getBoundingClientRect()
      return [...bar.children].some(
        (el) => !el.classList.contains('sr-only') && el.getBoundingClientRect().top >= lead.bottom,
      )
    })
    expect(wrappedBelow).toBe(true)

    // one gated bash call parks the turn on a permission dialog (exact: the
    // dock's live region announces the same sentence)
    await prompt.fill('Run the smoke tool call.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Allow `bash` tool call?', { exact: true })).toBeVisible({
      timeout: 30_000,
    })

    // the composer and the status bar gave their room to the cards
    await expect(page.locator('.composer-placeholder')).toHaveText('Answer the dialog above')
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveCount(0)
    await expect(page.locator('.status-bar')).toHaveCount(0)
    expect(await fitsWidth()).toBe(true)

    // a denial settles it, the turn runs on to its reply, and both return
    // with the page still inside the viewport
    await page.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled({ timeout: 30_000 })
    await expect(page.locator('.status-bar .spinner.idle')).toBeVisible({ timeout: 30_000 })
    // the earlier turn's reply sits above, the new one lands last
    const reply = page.getByLabel('Transcript', { exact: true }).getByText('The smoke test reply.')
    await expect(reply.last()).toBeVisible()
    await expect(page.locator('.status-bar')).toBeVisible()
    await expect(page.locator('.composer-placeholder')).toHaveCount(0)
    expect(await fitsWidth()).toBe(true)
  } finally {
    await phone.close()
  }
})

test('a toast stacks clear of the composer', async ({ page }) => {
  // jsdom lays nothing out, so the top-anchored stack is pinned against the
  // real composer at the desktop viewport
  await signIn(page)

  const card = page.locator('.grid .card').first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  // the grid opens into the focused workspace with that session selected
  await card.getByRole('link', { name: 'Open' }).click()
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled({ timeout: 30_000 })

  // a rewind pick reports through the toast stack, whatever the fake provider
  // answers: the refusal path toasts too
  await page.getByRole('button', { name: 'Rewind', exact: true }).click()
  await page.locator('.rewind-row:not(.head)').first().click()

  const toast = page.locator('.toast').first()
  await expect(toast).toBeVisible()
  const composer = page.locator('.composer')
  await expect(composer).toBeVisible()

  const [toastBox, composerBox] = await Promise.all([toast.boundingBox(), composer.boundingBox()])
  expect(toastBox).not.toBeNull()
  expect(composerBox).not.toBeNull()
  // rows hang from the top of the viewport, so no stack height reaches the
  // composer, the Send button or the status bar
  const clear =
    toastBox!.y + toastBox!.height <= composerBox!.y ||
    composerBox!.y + composerBox!.height <= toastBox!.y ||
    toastBox!.x + toastBox!.width <= composerBox!.x ||
    composerBox!.x + composerBox!.width <= toastBox!.x
  expect(clear).toBe(true)
})
