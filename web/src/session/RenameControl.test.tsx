import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RenameControl } from './RenameControl'
import { SwarmProvider } from '../providers/swarm'

// The desktop pencil trigger and the one shared rename editor behind it:
// opening seeds the row's label, saving writes swarm storage with a trimmed
// title (empty clears), failures keep the editor open with the server's
// message, and every close path skips the write.

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const pencil = () => screen.getByRole('button', { name: 'Rename project' })
const titleInput = () => screen.getByLabelText('Display title')

// noContent is the plain successful /title reply for indifferent tests.
const noContent = () => new Response(null, { status: 204 })

// stubApi answers discovery polls with an empty listing and shapes the /title
// reply through respondTitle.
function stubApi(respondTitle: () => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/title')) return respondTitle()
    return Response.json([])
  })
}

// titleCalls reads the /title POSTs off the current fetch stub.
function titleCalls(): string[] {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls
    .filter(([url]) => String(url).endsWith('/title'))
    .map(([, init]) => String(init?.body ?? ''))
}

// renderSettled mounts the pencil under SwarmProvider and lets its initial
// polls land inside act, so their state updates never warn outside it.
async function renderSettled() {
  render(
    <SwarmProvider>
      <RenameControl sessionId="01A" label="project" />
    </SwarmProvider>,
  )
  await vi.waitFor(() =>
    expect(
      (fetch as ReturnType<typeof vi.fn>).mock.calls.some(
        ([url]) => String(url) === '/api/sessions',
      ),
    ).toBe(true),
  )
}

async function openEditor() {
  const user = userEvent.setup()
  await user.click(pencil())
  expect(screen.getByRole('dialog', { name: 'Rename session' })).toBeInTheDocument()
  return user
}

describe('RenameControl', () => {
  it('pencil opens the shared editor seeded with the label', async () => {
    vi.stubGlobal('fetch', stubApi(noContent))
    await renderSettled()

    await openEditor()

    expect(screen.getByTestId('rename-01A')).toBeInTheDocument()
    expect(titleInput()).toHaveValue('project')
    expect(titleCalls()).toHaveLength(0)
  })

  it('saves the trimmed title and refreshes listings', async () => {
    vi.stubGlobal('fetch', stubApi(noContent))
    await renderSettled()

    const user = await openEditor()
    await user.clear(titleInput())
    await user.type(titleInput(), '  couch reading  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() => {
      expect(titleCalls()).toEqual([JSON.stringify({ title: 'couch reading' })])
    })

    // the listing refresh lands after the write, before the editor closes
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls
    const savedAt = calls.findIndex(([, init]) => String(init?.body ?? '').includes('couch'))
    expect(calls.slice(savedAt + 1).some(([url]) => String(url) === '/api/sessions')).toBe(true)
    await vi.waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rename session' })).not.toBeInTheDocument(),
    )
    expect(pencil()).toBeInTheDocument()
  })

  it('clears the stored title with an empty save', async () => {
    vi.stubGlobal('fetch', stubApi(noContent))
    await renderSettled()

    const user = await openEditor()
    await user.clear(titleInput())
    await user.type(titleInput(), '   ')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() => {
      expect(titleCalls()).toEqual([JSON.stringify({ title: '' })])
    })
  })

  it('keeps the editor open when saving fails', async () => {
    vi.stubGlobal(
      'fetch',
      stubApi(() => Response.json({ error: 'session_busy' }, { status: 409 })),
    )
    await renderSettled()

    const user = await openEditor()
    await user.clear(titleInput())
    await user.type(titleInput(), 'new name')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // no detail rode the envelope, so the surface fallback shows
    expect(await screen.findByText('Rename failed.')).toHaveClass('error-text')
    expect(screen.getByRole('dialog', { name: 'Rename session' })).toBeInTheDocument()
    expect(titleInput()).toHaveValue('new name')
  })

  it('closes on cancel and escape without writing', async () => {
    vi.stubGlobal('fetch', stubApi(noContent))
    await renderSettled()

    const user = await openEditor()
    await user.type(titleInput(), 'renamed')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Rename project' })).toBeInTheDocument()
    expect(titleCalls()).toHaveLength(0)

    // reopening starts a fresh edit; escape unwinds it the same way
    await user.click(pencil())
    await user.type(titleInput(), 'renamed again')
    await user.keyboard('{Escape}')
    await vi.waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rename session' })).not.toBeInTheDocument(),
    )
    expect(titleCalls()).toHaveLength(0)
  })

  it('disables actions while a save is in flight', async () => {
    let release!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      stubApi(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      ),
    )
    await renderSettled()

    const user = await openEditor()
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await act(async () => {
      release(new Response(null, { status: 204 }))
    })
    await vi.waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rename session' })).not.toBeInTheDocument(),
    )
  })
})
