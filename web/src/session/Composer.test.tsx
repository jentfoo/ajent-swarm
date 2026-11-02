import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Composer } from './Composer'
import type { ComposerProps } from './Composer'

// A controlled harness: SessionView owns the draft in production, so the test
// mirrors that by feeding onChange back into value.
function Harness(overrides: Partial<ComposerProps> = {}) {
  return <ControlledHarness {...overrides} />
}

function ControlledHarness(overrides: Partial<ComposerProps>) {
  const [value, setValue] = useState('')
  return (
    <Composer
      sessionId="01S"
      value={value}
      onChange={setValue}
      disabled={false}
      disabledReason=""
      onSubmit={() => {}}
      onSubmitFailed={() => {}}
      {...overrides}
    />
  )
}

const okSubmit = () =>
  vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.body && !(init.body instanceof FormData)) {
      return Response.json({ pendingId: 'p1' }, { status: 202 })
    }
    return Response.json({})
  })

describe('Composer submit flow', () => {
  it('sends on Enter with a client-minted pendingId and clears the draft', async () => {
    const user = userEvent.setup()
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body && !(init.body instanceof FormData)) {
          bodies.push(JSON.parse(String(init.body)))
          return Response.json({ pendingId: 'p1' }, { status: 202 })
        }
        return Response.json({})
      }),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt')
    await user.type(box, 'fix the bug{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]![0]).toBe('fix the bug')
    // a client-minted correlation rides every submit
    expect(String(onSubmit.mock.calls[0]![1]).length).toBeGreaterThan(8)
    await waitFor(() => expect(bodies[0]).toMatchObject({ line: 'fix the bug' }))
    expect(screen.getByLabelText('Prompt')).toHaveValue('')
  })

  it('submits slash and shell lines as-is without an optimistic row', async () => {
    const user = userEvent.setup()
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body && !(init.body instanceof FormData)) {
          bodies.push(JSON.parse(String(init.body)))
          return Response.json({ pendingId: 'p1' }, { status: 202 })
        }
        return Response.json({})
      }),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), '/help{Enter}')
    expect(onSubmit).not.toHaveBeenCalled() // slash lines paint no pending row
    expect(bodies[0]).toMatchObject({ line: '/help' })

    await user.type(screen.getByLabelText('Prompt'), '!ls -la{Enter}')
    // shell lines paint no optimistic row either
    expect(onSubmit).not.toHaveBeenCalled()
    expect(bodies[1]).toMatchObject({ line: '!ls -la' })
  })

  it('marks the optimistic row failed when the wire refuses', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'busy', message: 'queue is full' }, { status: 409 }),
      ),
    )
    const onSubmitFailed = vi.fn()
    render(Harness({ onSubmit: () => {}, onSubmitFailed }))

    await user.type(screen.getByLabelText('Prompt'), 'queued up{Enter}')
    await waitFor(() => expect(onSubmitFailed).toHaveBeenCalledOnce())
    expect(await screen.findByText(/queue is full/)).toBeInTheDocument()
  })

  it('keeps Shift+Enter from sending', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    render(Harness({}))
    await user.type(screen.getByLabelText('Prompt'), 'line one{Shift>}{Enter}more')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('disables sending while a dialog holds input', () => {
    render(
      Harness({
        disabled: true,
        disabledReason: 'A dialog needs an answer before prompts can send.',
      }),
    )
    expect(screen.getByLabelText('Prompt')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('Composer attachments', () => {
  it('uploads an image and appends an @path reference', async () => {
    const user = userEvent.setup()
    const uploads: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body instanceof FormData) {
          uploads.push(init.body)
          return Response.json({ path: '/home/you/.ajent/swarm/attachments/x.png' })
        }
        return Response.json({})
      }),
    )
    const onChange = vi.fn()
    render(Harness({ value: '', onChange }))

    const file = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    await user.upload(screen.getByTestId('attach-input'), file)

    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.get('file')).toBeInstanceOf(File)
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith('@/home/you/.ajent/swarm/attachments/x.png'),
    )
  })
})
