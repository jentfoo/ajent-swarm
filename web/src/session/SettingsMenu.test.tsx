import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SettingsMenu } from '../session/SettingsMenu'

// The shared settings.get/settings.set menu, exercised over mocked endpoints:
// rows render with their sources, booleans toggle in place, and text edits
// apply one call per change.

const ROWS = {
  rows: [
    { label: 'Verbose output', key: 'output.verbose', value: true, source: 'user', editable: true },
    {
      label: 'Model',
      key: 'model',
      value: 'sonnet',
      source: 'active',
      editable: false,
      reason: 'no layer sets it yet',
    },
  ],
}

// rows other chat chrome owns never render, on desktop or mobile
const CHROME_ROWS = {
  rows: [
    ...ROWS.rows,
    { label: 'Tools', key: 'tools.enabled', value: [], source: 'session', editable: true },
    {
      label: 'Permissions mode',
      key: 'permissions.mode',
      value: 'auto',
      source: '',
      editable: true,
    },
  ],
}

describe('SettingsMenu', () => {
  it('renders rows and applies one change per toggle', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).endsWith('/settings')) return Response.json(ROWS)
      if (String(url).endsWith('/setting')) {
        return Response.json({
          row: { ...ROWS.rows[0], value: false, source: 'session' },
        })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    vi.stubGlobal('fetch', fetchSpy)

    render(<SettingsMenu sessionId="01S" />)
    expect(await screen.findByText('Verbose output')).toBeInTheDocument()
    const user = userEvent.setup()

    // uneditable rows show their reason instead of a control
    expect(screen.getByText(/no layer sets it yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'on' })).toBeInTheDocument() // only the editable boolean

    await user.click(screen.getByRole('button', { name: 'on' }))
    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/setting'))
      expect(calls).toHaveLength(1)
      const body = JSON.parse(String(calls[0]![1]?.body))
      expect(body).toEqual({ key: 'output.verbose', value: false })
    })

    // the row re-renders from the reply
    expect(await screen.findByRole('button', { name: 'off' })).toBeInTheDocument()
  })

  it('edits text values through Apply with parsed JSON shapes', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).endsWith('/settings')) {
        return Response.json({
          rows: [{ label: 'Reasoning effort', key: 'reasoning.effort', value: 2, editable: true }],
        })
      }
      if (String(url).endsWith('/setting')) {
        return Response.json({
          row: { label: 'Reasoning effort', key: 'reasoning.effort', value: 3 },
        })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    vi.stubGlobal('fetch', fetchSpy)

    render(<SettingsMenu sessionId="01S" />)
    const input = await screen.findByDisplayValue('2')
    const userEdit = userEvent.setup()
    await userEdit.clear(input)
    await userEdit.type(input, '3')
    await userEdit.click(screen.getByRole('button', { name: 'Apply' }))

    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/setting'))
      expect(calls).toHaveLength(1)
      // the number shape survives the round trip, not a string "3"
      expect(JSON.parse(String(calls[0]![1]?.body)).value).toBe(3)
    })
  })

  it('drops tools and permission rows other chrome owns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/settings')) return Response.json(CHROME_ROWS)
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )

    render(<SettingsMenu sessionId="01S" />)
    expect(await screen.findByText('Verbose output')).toBeInTheDocument()
    expect(screen.queryByText('Tools')).not.toBeInTheDocument() // /tools buttons own it
    expect(screen.queryByText('Permissions mode')).not.toBeInTheDocument() // the dropdown owns it
  })

  it('edits the model row as a registry selection, not free text', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/sessions/01S/settings') {
        return Response.json({
          rows: [{ label: 'Model', key: 'model', value: 'sonnet', editable: true }],
        })
      }
      if (path === '/api/sessions/01S/models') {
        return Response.json({
          active: 'sonnet',
          models: [
            { key: 'sonnet', short: 'sonnet', window: 0, caps: {} },
            { key: 'haiku', short: 'haiku', window: 0, caps: {} },
          ],
        })
      }
      if (path === '/api/sessions/01S/setting') {
        return Response.json({ row: { label: 'Model', key: 'model', value: 'haiku' } })
      }
      throw new Error(`unexpected fetch ${String(url)} ${String(init?.method)}`)
    })
    vi.stubGlobal('fetch', fetchSpy)

    render(<SettingsMenu sessionId="01S" />)
    const select = await screen.findByRole('combobox', { name: 'Model' })
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2))
    expect(select).toHaveValue('sonnet')

    const user = userEvent.setup()
    await user.selectOptions(select, 'haiku')
    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/setting'))
      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ key: 'model', value: 'haiku' })
    })
  })
})
