import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DialogCardBody } from './DialogCardBody'
import type { InteractionPending } from '../api/types'

// The shared card body both docks render: shape dispatch and the permit note
// machine are one implementation, while layout only swaps control arrangement.
// Compact names a head card's options with digits and may take the caret,
// touch stacks full-width buttons and never steals focus.

const base = (overrides: Partial<InteractionPending>): InteractionPending => ({
  id: 42,
  kind: 'pick',
  prompt: 'Proceed?',
  ...overrides,
})

function stubFetch(reply: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return Response.json(reply)
    }),
  )
  return bodies
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderBody(
  dialog: InteractionPending,
  layout: 'compact' | 'touch',
  head = false,
  onNoteIntent = vi.fn(),
) {
  const onAnsweredLocally = vi.fn()
  render(
    <DialogCardBody
      dialog={dialog}
      sessionId="01S"
      layout={layout}
      head={head}
      onAnsweredLocally={onAnsweredLocally}
      onNoteIntent={onNoteIntent}
    />,
  )
  return { onAnsweredLocally, onNoteIntent }
}

const layouts = ['compact', 'touch'] as const

describe('DialogCardBody arrangement', () => {
  it('joins compact options in one actions row, digits on the head alone', () => {
    renderBody(base({ options: ['allow', 'deny'] }), 'compact')
    const allow = screen.getByRole('button', { name: 'allow' })
    expect(allow.closest('.dialog-actions')).not.toBeNull()
    expect(allow).not.toHaveAttribute('aria-keyshortcuts') // a stacked card, not the head
  })

  it('stacks touch options as full-width choice buttons', () => {
    renderBody(base({ options: ['permit', 'deny'] }), 'touch')

    for (const name of ['permit', 'deny']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveClass('dialog-choice')
      expect(button.closest('.dialog-actions')).toBeNull()
      expect(button.querySelector('.dialog-digit')).toBeNull()
      expect(button).not.toHaveAttribute('aria-keyshortcuts')
    }
  })

  it('names options with digits on a compact head card only', () => {
    renderBody(base({ options: ['allow', 'deny'] }), 'compact', true)

    const allow = screen.getByRole('button', { name: 'allow' })
    expect(allow).toHaveAttribute('aria-keyshortcuts', '1')
    expect(allow.querySelector('.dialog-digit')).toHaveTextContent('1')
    expect(screen.getByRole('button', { name: 'deny' })).toHaveAttribute('aria-keyshortcuts', '2')
  })

  it.each(layouts)('answers %s picks by visible position', async (layout) => {
    const bodies = stubFetch({ settled: false })
    renderBody(base({ options: ['allow', 'deny'] }), layout)

    await userEvent.click(screen.getByRole('button', { name: 'deny' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, index: 1 })
  })

  it.each(layouts)('confirms %s multi picks with the checked indexes', async (layout) => {
    const bodies = stubFetch({ settled: false })
    renderBody(base({ options: ['a', 'b'], multi: true }), layout)
    await userEvent.click(screen.getAllByRole('checkbox')[1])

    // compact confirms from the shared actions row, touch rides its own
    // primary button inside the list, both answer the same indexes
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    if (layout === 'compact') expect(confirm.closest('.dialog-actions')).not.toBeNull()
    else {
      expect(confirm.closest('.multipick')).not.toBeNull()
      expect(confirm).toHaveClass('primary')
    }

    await userEvent.click(confirm)
    expect(bodies.at(-1)).toEqual({ dialogId: 42, indexes: [1] })
  })
})

// The autofocus decision is the head grant alone (dialog-focus-policy.md):
// compact head cards take the caret on mount and keep it against later
// arrivals, everything else never steals focus.
describe('DialogCardBody focus', () => {
  const textDialog = base({ id: 7, kind: 'input', prompt: 'name?', text: true })
  const answerFor = (id: number) =>
    document.querySelector<HTMLInputElement>(`[data-dialog-id="${id}"] input`)!

  it('takes the caret on a compact head card', () => {
    renderBody(textDialog, 'compact', true)
    expect(document.activeElement).toBe(answerFor(7))
  })

  it('leaves stacked and background cards unfocused', () => {
    renderBody(textDialog, 'compact')
    expect(document.activeElement).toBe(document.body)
  })

  it('never takes the caret on touch', () => {
    renderBody(textDialog, 'touch')
    expect(document.activeElement).toBe(document.body)
  })
})

// Permit cards hide "Allow with note" behind their own optional input in both
// arrangements: a typed note rides the Allow or Deny pick and records the
// pending intent that resolves the barrier's follow-up ask (decisionNote.ts).
describe('DialogCardBody permit note ride', () => {
  const permitDialog = base({
    kind: 'decision',
    prompt: 'Allow `rm` tool call?',
    options: ['Allow', 'Allow with note', 'Deny'],
  })

  const noteInput = () => screen.getByPlaceholderText('Note for the agent (optional)')

  it.each(layouts)('hides allow-with-note on %s cards', (layout) => {
    renderBody(permitDialog, layout)
    expect(screen.queryByRole('button', { name: 'Allow with note' })).not.toBeInTheDocument()
    expect(noteInput()).toBeInTheDocument()
  })

  it.each(layouts)('rides a typed note on the %s deny pick', async (layout) => {
    const bodies = stubFetch({ settled: false })
    const { onNoteIntent } = renderBody(permitDialog, layout)
    await userEvent.type(noteInput(), 'too risky')

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, index: 2 })
    expect(onNoteIntent).toHaveBeenCalledWith(42, 'too risky', true)
  })

  it.each(layouts)('turns a %s allow pick into allow-with-note', async (layout) => {
    const bodies = stubFetch({ settled: false })
    const { onNoteIntent } = renderBody(permitDialog, layout)
    await userEvent.type(noteInput(), 'only inside build/')

    // the hidden allow-with-note choice answers, not plain allow
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, index: 1 })
    expect(onNoteIntent).toHaveBeenCalledWith(42, 'only inside build/', false)
  })

  it.each(layouts)('answers a %s plain allow without an intent', async (layout) => {
    const bodies = stubFetch({ settled: false })
    const { onNoteIntent } = renderBody(permitDialog, layout)

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, index: 0 })
    expect(onNoteIntent).not.toHaveBeenCalled()
  })
})

// Secrets never echo: compact cards mask an inline answer, touch takes over a
// dedicated screen with show and hide.
describe('DialogCardBody secrets', () => {
  const secret = base({ kind: 'secret', prompt: 'API key?', text: true, secret: true })

  it('masks the answer inline on compact cards', async () => {
    const bodies = stubFetch({ settled: false })
    renderBody(secret, 'compact')

    const input = screen.getByLabelText('Secret answer')
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.type(input, 's3cret')
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, text: 's3cret' })
  })

  it.each(layouts)('keeps a %s secret retyping while an answer is in flight', async (layout) => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)))
        await held
        return Response.json({ settled: false })
      }),
    )
    renderBody(secret, layout)
    const input = screen.getByLabelText('Secret answer')

    const user = userEvent.setup()
    await user.type(input, 'first')
    await user.click(screen.getByRole('button', { name: 'Answer' }))
    expect(bodies).toEqual([{ dialogId: 42, text: 'first' }])

    await user.type(input, 'second')
    // Enter repeats submit past the disabled answer button
    fireEvent.submit(input.closest('form')!)
    expect(bodies).toEqual([{ dialogId: 42, text: 'first' }])
    expect(input).toHaveValue('second')

    await act(async () => release())
  })

  it('takes over a dedicated screen on touch with show and hide', async () => {
    const bodies = stubFetch({ settled: false })
    renderBody(secret, 'touch')

    const input = screen.getByLabelText('Secret answer')
    expect(input.closest('.secret-screen')).not.toBeNull()
    await userEvent.type(input, 's3cret')

    await userEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(input).toHaveAttribute('type', 'text')
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(input).toHaveAttribute('type', 'password')

    await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(bodies.at(-1)).toEqual({ dialogId: 42, text: 's3cret' })
  })
})
