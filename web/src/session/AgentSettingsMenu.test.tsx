import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentSettingsMenu } from './AgentSettingsMenu'
import { GlobalSettingsMenu } from '../shell/GlobalSettingsMenu'

// Both ☰ menus ride one shared dialog shell: opening renders the body as a
// centered modal over a backdrop, and backdrop click or Escape closes it.

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const path = String(url).split('?')[0]
      for (const [suffix, body] of Object.entries(routes)) {
        if (path.endsWith(suffix)) return Response.json(body)
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    }),
  )
}

describe('AgentSettingsMenu', () => {
  it('opens the settings dialog inside a backdrop', async () => {
    stubFetch({ '/settings': { rows: [] } })
    render(<AgentSettingsMenu sessionId="01S" />)

    const trigger = screen.getByRole('button', { name: 'Agent settings' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.setup().click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const dialog = screen.getByRole('dialog', { name: 'Agent settings' })
    expect(document.querySelector('.modal-backdrop')).toContainElement(dialog)
  })

  it('closes on backdrop click and escape but not inner clicks', async () => {
    stubFetch({ '/settings': { rows: [] } })
    const user = userEvent.setup()
    render(<AgentSettingsMenu sessionId="01S" />)

    await user.click(screen.getByRole('button', { name: 'Agent settings' }))
    // clicks inside the dialog leave it open
    fireEvent.click(screen.getByRole('dialog', { name: 'Agent settings' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    await user.click(screen.getByRole('button', { name: 'Agent settings' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders global settings through the same shell', async () => {
    stubFetch({ '/api/settings': { titleModel: '' }, '/api/models/options': [] })
    render(<GlobalSettingsMenu />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Global settings' }))
    expect(
      document.querySelector('.modal-backdrop')!.querySelector('.card.modal.settings-modal'),
    ).toContainElement(screen.getByRole('dialog', { name: 'Global settings' }))
    expect(await screen.findByLabelText('Session titling model')).toBeInTheDocument()

    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(screen.queryByRole('dialog', { name: 'Global settings' })).not.toBeInTheDocument()
  })
})
