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
  it('keeps every row label before its control and action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/settings')) return Response.json(ROWS)
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )

    render(<SettingsMenu sessionId="01S" />)
    await screen.findByText('Verbose output')

    // the grid tracks key off source order: label first, then control, then
    // the row's action slot where one exists. The uneditable model row renders
    // its muted value in the control slot (theme.css spans it to the action)
    const toggleRow = document.querySelector('[data-setting-key="output.verbose"]')!
    expect(toggleRow.children[0]).toHaveClass('setting-label')
    expect(toggleRow.children[1]!.tagName).toBe('BUTTON')

    const modelRow = document.querySelector('[data-setting-key="model"]')!
    expect(modelRow.children[0]).toHaveClass('setting-label')
    expect(modelRow.children[1]).toHaveClass('setting-value')
  })

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
    // the toggle names its setting, the state rides aria-pressed
    const toggle = screen.getByRole('button', { name: 'Verbose output' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    await user.click(toggle)
    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/setting'))
      expect(calls).toHaveLength(1)
      const body = JSON.parse(String(calls[0]![1]?.body))
      expect(body).toEqual({ key: 'output.verbose', value: false })
    })

    // the row re-renders from the reply
    const applied = await screen.findByRole('button', { name: 'Verbose output' })
    expect(applied).toHaveAttribute('aria-pressed', 'false')
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
    const input = await screen.findByRole('textbox', { name: 'Reasoning effort' })
    // the untouched form renders no action; typing reveals Apply in the row's
    // last slot behind its label and control (theme.css tracks source order)
    const userEdit = userEvent.setup()
    await userEdit.clear(input)
    await userEdit.type(input, '3')
    const editor = input.closest('.setting-row')!
    expect(editor.children[0]).toHaveClass('setting-label')
    expect(editor.children[1]).toBe(input)
    expect(editor.children[2]).toHaveTextContent('Apply')

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

  it('announces a refused change as an alert', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/settings')) return Response.json(ROWS)
      if (String(url).endsWith('/setting')) {
        return Response.json({ error: 'invalid_request', message: 'read only' }, { status: 400 })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    vi.stubGlobal('fetch', fetchSpy)

    render(<SettingsMenu sessionId="01S" />)
    await screen.findByText('Verbose output')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Verbose output' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('read only')
  })

  it('marks the rows load busy until they land', async () => {
    let release!: (r: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      ),
    )

    render(<SettingsMenu sessionId="01S" />)
    const loading = screen.getByText('Reading settings…')
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveAttribute('aria-busy', 'true')

    // the paragraph unmounts once rows land, so nothing stays busy
    release(Response.json(ROWS))
    await screen.findByText('Verbose output')
    expect(screen.queryByText('Reading settings…')).not.toBeInTheDocument()
  })

  it('edits the model row as a registry selection, not free text', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/sessions/01S/settings') {
        return Response.json({
          rows: [{ label: 'Model', key: 'model', value: 'anthropic/sonnet', editable: true }],
        })
      }
      if (path === '/api/sessions/01S/models') {
        return Response.json({
          active: 'anthropic/sonnet',
          models: [
            { key: 'anthropic/sonnet', short: 'sonnet', window: 0, caps: {} },
            { key: 'anthropic/haiku', short: 'haiku', window: 0, caps: {} },
            { key: 'openai/gpt-5', short: 'gpt-5', window: 0, caps: {} },
            { key: 'local-tuned', short: '', window: 0, caps: {} },
          ],
        })
      }
      if (path === '/api/sessions/01S/setting') {
        return Response.json({ row: { label: 'Model', key: 'model', value: 'anthropic/haiku' } })
      }
      throw new Error(`unexpected fetch ${String(url)} ${String(init?.method)}`)
    })
    vi.stubGlobal('fetch', fetchSpy)

    render(<SettingsMenu sessionId="01S" />)
    const select = await screen.findByRole('combobox', { name: 'Model' })
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(4))
    expect(select).toHaveValue('anthropic/sonnet')

    const user = userEvent.setup()
    await user.selectOptions(select, 'anthropic/haiku')
    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/setting'))
      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({
        key: 'model',
        value: 'anthropic/haiku',
      })
    })
  })
})
