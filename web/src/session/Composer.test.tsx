import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Composer } from './Composer'
import type { ComposerProps } from './Composer'

type Suggestion = { path: string; dir?: boolean }

// filesFetch answers /files lookups from a query -> suggestions table so
// re-completion tests can vary the candidates per token state.
function filesFetch(byQuery: Record<string, Suggestion[]>) {
  return vi.fn(async (url: string | URL) => {
    const q = new URL(String(url), 'http://localhost').searchParams.get('query')
    if (q !== null && q in byQuery) return Response.json({ items: byQuery[q] })
    return Response.json({})
  })
}

// component swaps the module under test; the coarse-pointer cases re-import
// Composer with matchMedia stubbed, since the flag reads once at import.
type HarnessOverrides = Partial<ComposerProps> & { component?: typeof Composer }

// A controlled harness: SessionView owns the draft in production, so the test
// mirrors that by feeding onChange back into value.
function Harness(overrides: HarnessOverrides = {}) {
  return <ControlledHarness {...overrides} />
}

function ControlledHarness({ component: Component = Composer, ...overrides }: HarnessOverrides) {
  const [value, setValue] = useState('')
  return (
    <Component
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

describe('Composer @-completion', () => {
  it('offers files after an @ token and Tab accepts one', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/files')) {
          return Response.json({ items: [{ path: 'src/main.go' }, { path: 'src/', dir: true }] })
        }
        return Response.json({})
      }),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt')
    await user.type(box, 'look at @ma')

    const menu = await screen.findByRole('listbox', { name: 'Path suggestions' })
    expect(menu).toBeInTheDocument()
    await user.tab()

    // the token became the completed path; files end with a space
    expect((box as HTMLTextAreaElement).value).toBe('look at @src/main.go ')
  })

  it('accepts a suggestion on tap, directories keeping their separator', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/files')) {
          return Response.json({ items: [{ path: 'src/main.go' }, { path: 'src/', dir: true }] })
        }
        return Response.json({})
      }),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'check @s')
    const menu = await screen.findByRole('listbox', { name: 'Path suggestions' })

    // a tap list above the keyboard: the directory suggestion completes with
    // its separator so the next query continues from it
    const options = menu.querySelectorAll<HTMLButtonElement>('[role="option"]')
    expect(options).toHaveLength(2)
    await user.click(options[1]!)
    expect(box.value).toBe('check @src/')
  })

  it('sends on Enter while no menu is open', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [] })),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), '@nothing-here{Enter}')
    // no suggestions appeared, so Enter kept its send role
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]![0]).toBe('@nothing-here')
  })
})

describe('Composer caret and completion keys', () => {
  it('drops_the_caret_after_an_accepted_token', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/files')) {
          return Response.json({ items: [{ path: 'src/main.go' }] })
        }
        return Response.json({})
      }),
    )
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @ma')
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    await user.tab()

    // the selection sits past the trailing space, where typing continues
    expect(box.value).toBe('look at @src/main.go ')
    expect(box.selectionStart).toBe(box.value.length)
    expect(box.selectionEnd).toBe(box.value.length)
  })

  it('closes_the_menu_so_tab_cannot_splice_twice', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/files')) {
          return Response.json({ items: [{ path: 'src/main.go' }] })
        }
        return Response.json({})
      }),
    )
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @ma')
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    await user.tab()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.tab() // no token remains to complete

    expect(box.value).toBe('look at @src/main.go ')
  })

  it('unmoved_enter_submits_the_draft_as_typed', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', filesFetch({ ma: [{ path: 'src/main.go' }] }))
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @ma')
    await screen.findByRole('listbox', { name: 'Path suggestions' })

    // the highlight was never moved, so Enter keeps its send role
    await user.type(box, '{Enter}')

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]![0]).toBe('look at @ma')
  })

  it('moved_enter_completes_then_sends', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      filesFetch({ s: [{ path: 'src/main.go' }, { path: 'src/', dir: true }] }),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), 'see @s')
    await screen.findByRole('listbox', { name: 'Path suggestions' })

    // arrows move the selection, so Enter accepts and submits in one key
    await user.type(screen.getByLabelText('Prompt'), '{ArrowDown}{Enter}')

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]![0]).toBe('see @src/')
  })

  it('shift_enter_stays_a_newline_while_open', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', filesFetch({ ma: [{ path: 'src/main.go' }] }))
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @ma')
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    await user.type(box, '{Shift>}{Enter}{/Shift}more')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(box.value).toBe('look at @ma\nmore')
    // the newline ends the token, so the menu closed with it
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('escape_closes_without_side_effects', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', filesFetch({ ma: [{ path: 'src/main.go' }] }))
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @ma')
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    await user.type(box, '{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box.value).toBe('look at @ma')

    // a dismissed menu never intercepts the next Enter
    await user.type(box, '{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]![0]).toBe('look at @ma')
  })

  it('mid_path_completion_keeps_the_tail', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      filesFetch({
        s: [{ path: 'src/', dir: true }, { path: 'src/main.go' }],
        'src/': [{ path: 'src/main.go' }],
      }),
    )
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'see @s')
    await screen.findByRole('listbox', { name: 'Path suggestions' })

    // the directory completes with its separator so the token stays open
    await user.tab()
    expect(box.value).toBe('see @src/')

    // the refetched candidates replace the stale list, then complete the path
    const menu = screen.getByRole('listbox', { name: 'Path suggestions' })
    await waitFor(() => expect(menu.querySelectorAll('[role="option"]')).toHaveLength(1))
    await user.tab()

    // the refetched candidate replaces only the query, text after it survives
    expect(box.value).toBe('see @src/main.go ')
    expect(box.selectionStart).toBe(box.value.length)
  })
})

describe('Composer touch keyboard', () => {
  // The coarse-pointer flag reads once at module scope, so the touch cases
  // re-import the module with matchMedia stubbed; every other test in this
  // file runs on the fine-pointer default the test setup ships.
  async function coarseComposer(): Promise<typeof Composer> {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
    vi.resetModules()
    return (await import('./Composer')).Composer
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('coarse_enter_inserts_a_newline', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    render(Harness({ component: await coarseComposer() }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    expect(box.placeholder).toBe('Send a prompt — Enter for newline, Send to submit')
    await user.type(box, 'line one{Enter}line two')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(box.value).toBe('line one\nline two')

    // the Send button stays the touch submit path
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(fetchSpy).toHaveBeenCalledOnce()
    await waitFor(() => expect(box).toHaveValue(''))
  })

  it('coarse_menu_enter_accepts_suggestion', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(filesFetch({ ma: [{ path: 'src/main.go' }] }))
    vi.stubGlobal('fetch', fetchSpy)
    const onSubmit = vi.fn()
    render(Harness({ component: await coarseComposer(), onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @ma')
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    await user.type(box, '{Enter}')

    // Enter accepted the highlighted path instead of sending or a newline
    expect(onSubmit).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledOnce() // the files lookup only
    expect(box.value).toBe('look at @src/main.go ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('coarse_moved_enter_accepts_not_sends', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(
      filesFetch({ s: [{ path: 'src/main.go' }, { path: 'src/', dir: true }] }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const onSubmit = vi.fn()
    render(Harness({ component: await coarseComposer(), onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'see @s')
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    await user.type(box, '{ArrowDown}{Enter}')

    // the moved-selection complete-then-send shortcut stays desktop-only
    expect(onSubmit).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(box.value).toBe('see @src/')
  })

  it('fine_pointer_keeps_send_and_newline', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'line one{Shift>}{Enter}')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(box.value).toBe('line one\n')

    await user.type(box, 'line two{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]![0]).toBe('line one\nline two')
    await waitFor(() => expect(box).toHaveValue(''))
  })
})

describe('Composer submit flow', () => {
  it('sends on Enter with a client-minted pendingId and clears once accepted', async () => {
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
    // acceptance clears; until then the draft stays exactly as typed
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(''))
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

  it('keeps the draft in the composer when a submit is refused', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'unavailable' }, { status: 409 })),
    )
    render(Harness({}))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'my unsent idea{Enter}')
    expect(await screen.findByText(/unavailable/)).toBeInTheDocument()
    // the refused text stays right where it was typed
    expect(box.value).toBe('my unsent idea')
  })

  it('fires one submit while an identical line is still unanswered', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})), // never answers
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), 'once only{Enter}{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('clears nothing an edit touched while a submit was on the wire', async () => {
    const user = userEvent.setup()
    let accept!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (accept = r))),
    )
    render(Harness({}))

    await user.type(screen.getByLabelText('Prompt'), 'hello{Enter}')
    // typing reshaped the draft before the reply landed
    await user.type(screen.getByLabelText('Prompt'), ' world')
    accept(Response.json({}, { status: 202 }))
    await act(async () => {}) // let the acceptance continuation run
    expect(screen.getByLabelText('Prompt')).toHaveValue('hello world')
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

  it('inlines a small text file as a fenced block without uploading', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    const onChange = vi.fn()
    render(Harness({ value: '', onChange }))

    const file = new File(['const one = 1\n'], 'notes.txt', { type: 'text/plain' })
    await user.upload(screen.getByTestId('attach-input'), file)

    // no upload call happened; the body landed in the draft fenced
    await waitFor(() => {
      expect(onChange).toHaveBeenCalled()
      const draft = String(onChange.mock.calls[0]![0])
      expect(draft).toContain('`notes.txt`:')
      expect(draft).toContain('```\nconst one = 1\n```')
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to uploading an oversize text file', async () => {
    const user = userEvent.setup()
    const uploads: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body instanceof FormData) {
          uploads.push(init.body)
          return Response.json({ path: '/state/big.log' })
        }
        return Response.json({})
      }),
    )
    const onChange = vi.fn()
    render(Harness({ value: '', onChange }))

    // 65KB of text exceeds the inline cap and rides @path instead
    const big = 'x'.repeat((64 << 10) + 1)
    const file = new File([big], 'big.txt', { type: 'text/plain' })
    await user.upload(screen.getByTestId('attach-input'), file)

    await waitFor(() => expect(uploads).toHaveLength(1))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('@/state/big.log'))
  })
})
