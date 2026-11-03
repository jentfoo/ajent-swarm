import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useLaunchForm } from './useLaunchForm'
import type { LaunchTarget } from './useLaunchForm'

// The launch form body every launcher surface shares: the workspace pick with
// its custom reveal, the model select, and the busy/error flow around
// fleet.launch. Targets stay with each surface.

function FormProbe({ target }: { target: LaunchTarget }) {
  const form = useLaunchForm()
  return (
    <div>
      <select
        aria-label="workspace"
        value={form.workspaceChoice}
        onChange={(ev) => form.setWorkspaceChoice(ev.target.value)}
      >
        <option value="">Custom path…</option>
        <option value="/w">/w</option>
      </select>
      <input
        aria-label="custom"
        value={form.customWorkspace}
        onChange={(ev) => form.setCustomWorkspace(ev.target.value)}
      />
      <select
        aria-label="model"
        value={form.model}
        onChange={(ev) => form.setModel(ev.target.value)}
      >
        <option value="">ajent default</option>
        <option value="p/m">p/m</option>
      </select>
      <span data-testid="busy">{String(form.busy)}</span>
      <span data-testid="error">{form.error}</span>
      <span data-testid="workspace">{form.workspace}</span>
      <button
        type="button"
        onClick={() =>
          void form.launch(target).then((id) => {
            if (id !== null) window.dispatchEvent(new CustomEvent('launched', { detail: id }))
          })
        }
      >
        launch
      </button>
    </div>
  )
}

function stubFetch(respond: (body: Record<string, unknown>) => Response) {
  const spy = vi.fn(async (_url: string | URL, init?: RequestInit) =>
    respond(JSON.parse(String(init?.body ?? '{}'))),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('useLaunchForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves the workspace from the choice or the custom reveal', async () => {
    const user = userEvent.setup()
    stubFetch(() => Response.json({ sessionId: '01NEW' }))
    render(<FormProbe target={{ mode: 'new' }} />)

    expect(screen.getByTestId('workspace')).toHaveTextContent('')
    await user.type(screen.getByLabelText('custom'), '/custom/path')
    expect(screen.getByTestId('workspace')).toHaveTextContent('/custom/path')

    await user.selectOptions(screen.getByLabelText('workspace'), '/w')
    expect(screen.getByTestId('workspace')).toHaveTextContent('/w')
  })

  it('refuses an empty workspace without posting', async () => {
    const user = userEvent.setup()
    const spy = stubFetch(() => Response.json({ sessionId: '01NEW' }))
    render(<FormProbe target={{ mode: 'new' }} />)

    await user.click(screen.getByRole('button', { name: 'launch' }))

    expect(screen.getByTestId('error')).toHaveTextContent(
      'Pick the working directory to start under.',
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('posts the surface target with the resolved workspace and model', async () => {
    const user = userEvent.setup()
    const spy = stubFetch(() => Response.json({ sessionId: '01NEW' }))
    render(<FormProbe target={{ mode: 'resume', target: '01OLD' }} />)

    await user.selectOptions(screen.getByLabelText('workspace'), '/w')
    await user.selectOptions(screen.getByLabelText('model'), 'p/m')
    await user.click(screen.getByRole('button', { name: 'launch' }))

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![1]?.body && JSON.parse(String(spy.mock.calls[0]![1]?.body))).toEqual({
      workspace: '/w',
      mode: 'resume',
      target: '01OLD',
      model: 'p/m',
    })
  })

  it('omits the model when the default rides', async () => {
    const user = userEvent.setup()
    const spy = stubFetch(() => Response.json({ sessionId: '01NEW' }))
    render(<FormProbe target={{ mode: 'new' }} />)

    await user.selectOptions(screen.getByLabelText('workspace'), '/w')
    await user.click(screen.getByRole('button', { name: 'launch' }))

    const body = JSON.parse(String(spy.mock.calls[0]![1]?.body))
    expect(body).toEqual({ workspace: '/w', mode: 'new' })
    expect('model' in body).toBe(false)
  })

  it('resolves the launched session id on success', async () => {
    const user = userEvent.setup()
    stubFetch(() => Response.json({ sessionId: '01NEW' }))
    const launched: string[] = []
    const onLaunched = (ev: Event) => launched.push((ev as CustomEvent<string>).detail)
    window.addEventListener('launched', onLaunched)
    render(<FormProbe target={{ mode: 'new' }} />)

    try {
      await user.selectOptions(screen.getByLabelText('workspace'), '/w')
      await user.click(screen.getByRole('button', { name: 'launch' }))
      await vi.waitFor(() => expect(launched).toEqual(['01NEW']))
      expect(screen.getByTestId('error')).toHaveTextContent('')
    } finally {
      window.removeEventListener('launched', onLaunched)
    }
  })

  it('surfaces a refusal, returns null and re-enables', async () => {
    const user = userEvent.setup()
    stubFetch(() =>
      Response.json({ error: 'invalid_request', message: 'workspace missing' }, { status: 400 }),
    )
    const launched: string[] = []
    const onLaunched = (ev: Event) => launched.push((ev as CustomEvent<string>).detail)
    window.addEventListener('launched', onLaunched)
    render(<FormProbe target={{ mode: 'new' }} />)

    try {
      await user.selectOptions(screen.getByLabelText('workspace'), '/w')
      await user.click(screen.getByRole('button', { name: 'launch' }))

      await vi.waitFor(() =>
        expect(screen.getByTestId('error')).toHaveTextContent('invalid_request: workspace missing'),
      )
      expect(screen.getByTestId('busy')).toHaveTextContent('false')
      expect(launched).toEqual([])
    } finally {
      window.removeEventListener('launched', onLaunched)
    }
  })
})
