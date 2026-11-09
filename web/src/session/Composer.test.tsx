import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Composer, excludedHint, stagedHint } from './Composer'
import type { ComposerProps, ComposerRecall } from './Composer'
import { commandDocs } from './commands'
import { prependDraft } from './draftStore'
import { coarseImport } from '../test/matchMedia'

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

// deferredFiles holds every /files reply until the test releases it, so
// staleness cases pin the exact order replies land in regardless of timers.
function deferredFiles() {
  const pending = new Map<string, (res: Response) => void>()
  const fetchSpy = vi.fn(
    (url: string | URL) =>
      new Promise<Response>((resolve) => {
        const q = new URL(String(url), 'http://localhost').searchParams.get('query') ?? ''
        pending.set(q, resolve)
      }),
  )
  return {
    fetchSpy,
    fired: (query: string) => pending.has(query),
    reply: (query: string, items: Suggestion[]) => pending.get(query)!(Response.json({ items })),
  }
}

// deferredUpload holds the attachment POST reply until released, so tests can
// land draft edits between picking a file and its upload resolving.
function deferredUpload() {
  let resolve!: (res: Response) => void
  const fetchSpy = vi.fn((_url: string | URL, init?: RequestInit) => {
    if (init?.body instanceof FormData)
      return new Promise<Response>((r) => {
        resolve = r
      })
    return Response.json({})
  })
  return { fetchSpy, reply: (res: Response) => resolve(res) }
}

// component swaps the module under test, the coarse-pointer cases re-import
// Composer with matchMedia stubbed, since the flag reads once at import.
type HarnessOverrides = Partial<ComposerProps> & { component?: typeof Composer }

// A controlled harness: SessionView owns the draft in production, so the test
// mirrors that by feeding onChange back into value. A wired recall's accept
// returns the draft it produced, the harness applies it through the same
// write, mirroring the hosts' setDraft side effect. Recall defaults to an
// empty source under the real prepend rule.
function Harness(overrides: HarnessOverrides = {}) {
  return <ControlledHarness {...overrides} />
}

function ControlledHarness({ component: Component = Composer, ...overrides }: HarnessOverrides) {
  const [value, setValue] = useState('')
  const { recall = { items: [], accept: prependDraft } } = overrides
  const props: ComposerProps = {
    sessionId: '01S',
    value,
    onChange: setValue,
    disabled: false,
    disabledReason: '',
    onSubmit: () => {},
    onSubmitFailed: () => {},
    ...overrides,
    recall: {
      items: recall.items,
      accept: (text: string, current: string) => {
        const next = recall.accept(text, current)
        setValue(next)
        return next
      },
    },
  }
  return <Component {...props} />
}

const okSubmit = () =>
  vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.body && !(init.body instanceof FormData)) {
      return Response.json({ pendingId: 'p1' }, { status: 202 })
    }
    return Response.json({})
  })

// coarseComposer re-imports Composer with matchMedia stubbed, since the
// coarse-pointer flag reads once at module scope. Every other test in this
// file runs on the fine-pointer default the test setup ships.
async function coarseComposer(): Promise<typeof Composer> {
  return (await coarseImport(() => import('./Composer'))).Composer
}

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

    // the token became the completed path, files end with a space
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

  it('backspace_window_tab_splices_nothing', async () => {
    const user = userEvent.setup()
    const files = deferredFiles()
    vi.stubGlobal('fetch', files.fetchSpy)
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @sr')
    await waitFor(() => expect(files.fired('sr')).toBe(true))
    files.reply('sr', [{ path: 'src/robot.go' }])
    const stale = await screen.findByRole('listbox', { name: 'Path suggestions' })
    expect(stale.querySelector('[role="option"]')).toHaveTextContent('src/robot.go')

    // backspace rewinds the token inside the debounce plus network window: the
    // sr rows no longer answer it, so Tab has nothing to splice
    await user.type(box, '{Backspace}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.tab()
    expect(box.value).toBe('look at @s')

    // fresh rows for the current token render as soon as they land, and only
    // those splice
    await waitFor(() => expect(files.fired('s')).toBe(true))
    files.reply('s', [{ path: 'src/main.go' }])
    const menu = await screen.findByRole('listbox', { name: 'Path suggestions' })
    expect(menu.querySelector('[role="option"]')).toHaveTextContent('src/main.go')
    box.focus()
    await user.tab()
    expect(box.value).toBe('look at @src/main.go ')
  })

  it('extended_token_window_tab_splices_nothing', async () => {
    const user = userEvent.setup()
    const files = deferredFiles()
    vi.stubGlobal('fetch', files.fetchSpy)
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'see @s')
    await waitFor(() => expect(files.fired('s')).toBe(true))
    files.reply('s', [{ path: 'src/main.go' }, { path: 'swarm.log' }])
    await screen.findByRole('listbox', { name: 'Path suggestions' })

    // typing widens the token past the fetched rows: an s-only path like
    // swarm.log must not splice while the src lookup is still pending
    await user.type(box, 'rc')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await user.tab()
    expect(box.value).toBe('see @src')

    await waitFor(() => expect(files.fired('src')).toBe(true))
    files.reply('src', [{ path: 'src/', dir: true }])
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    box.focus()
    await user.tab()
    expect(box.value).toBe('see @src/')
  })

  it('stale_reply_landing_late_renders_nothing', async () => {
    const user = userEvent.setup()
    const files = deferredFiles()
    vi.stubGlobal('fetch', files.fetchSpy)
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @sr')
    await waitFor(() => expect(files.fired('sr')).toBe(true))
    await user.type(box, 'c')
    await waitFor(() => expect(files.fired('src')).toBe(true))

    // the sr reply races its abort and lands after the token moved on: its
    // rows render nowhere
    files.reply('sr', [{ path: 'src/robot.go' }])
    await act(async () => {})
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    files.reply('src', [{ path: 'src/main.go' }])
    const menu = await screen.findByRole('listbox', { name: 'Path suggestions' })
    expect(menu.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(menu.querySelector('[role="option"]')).toHaveTextContent('src/main.go')
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

    // the fresh query's rows reopen the menu, then complete the path
    const menu = await screen.findByRole('listbox', { name: 'Path suggestions' })
    expect(menu.querySelectorAll('[role="option"]')).toHaveLength(1)
    await user.tab()

    // the refetched candidate replaces only the query, text after it survives
    expect(box.value).toBe('see @src/main.go ')
    expect(box.selectionStart).toBe(box.value.length)
  })
})

describe('Composer slash command menu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // commandNames reads the command column of the open menu, in row order
  const commandNames = () =>
    Array.from(
      screen.getByRole('listbox', { name: 'Commands' }).querySelectorAll('.slash-name'),
    ).map((el) => el.textContent)

  it('opens on a line-initial slash listing descriptions', async () => {
    const user = userEvent.setup()
    render(Harness())

    await user.type(screen.getByLabelText('Prompt'), '/')

    const menu = screen.getByRole('listbox', { name: 'Commands' })
    const options = menu.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(commandDocs.length)
    expect(options[0]).toHaveTextContent('/help')
    // every row teaches its command's one-line description
    for (const opt of Array.from(options)) {
      expect(opt.querySelector('.slash-desc')?.textContent).toBeTruthy()
    }
  })

  it('narrows per keystroke prefix then substring', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '/s')
    expect(commandNames()).toEqual([
      '/session',
      '/settings',
      '/reasoning',
      '/usage',
      '/tools',
      '/agents',
      '/plan-stop',
      '/plan-status',
    ])

    await user.type(box, 'et')
    expect(commandNames()).toEqual(['/settings'])

    await user.type(box, 'zzz')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('tab accepts the highlighted command', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '/us')
    await user.tab()

    // the trailing space ends the token, so the next Enter submits
    expect(box).toHaveValue('/usage ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('moved enter accepts and submits in one press', async () => {
    const user = userEvent.setup()
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body && !(init.body instanceof FormData)) {
          bodies.push(JSON.parse(String(init.body)))
          return Response.json({}, { status: 202 })
        }
        return Response.json({})
      }),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), '/mod{ArrowDown}{Enter}')

    // slash lines paint no optimistic row, the accepted command rides the wire
    expect(onSubmit).not.toHaveBeenCalled()
    expect(bodies[0]).toMatchObject({ line: '/model' })
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(''))
  })

  it('unmoved enter submits the line as typed', async () => {
    const user = userEvent.setup()
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body && !(init.body instanceof FormData)) {
          bodies.push(JSON.parse(String(init.body)))
          return Response.json({}, { status: 202 })
        }
        return Response.json({})
      }),
    )
    render(Harness())

    // an unknown command still submits: the menu never blocks a hand-typed line
    await user.type(screen.getByLabelText('Prompt'), '/hel{Enter}')

    expect(bodies[0]).toMatchObject({ line: '/hel' })
  })

  it('escape dismisses without inserting', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '/mo')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()
    await user.type(box, '{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box).toHaveValue('/mo')

    // the dismissal rides the query: typing past it reopens the menu
    await user.type(box, 'd')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()

    // and a dismissed menu never swallows the send
    await user.type(box, '{Escape}{Enter}')
    await waitFor(() => expect(box).toHaveValue(''))
  })

  it('arrows clamp at the ends and mark the move', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt')
    await user.type(box, '/pl')
    const options = () => screen.getAllByRole('option')

    await user.type(box, '{ArrowDown}')
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
    await user.type(box, '{ArrowDown}{ArrowDown}')
    expect(options()[2]).toHaveAttribute('aria-selected', 'true') // clamped at the last
    await user.type(box, '{ArrowUp}')
    expect(options()[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('tap accepts a row into the draft', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '/he')
    const menu = screen.getByRole('listbox', { name: 'Commands' })
    await user.click(menu.querySelectorAll<HTMLButtonElement>('[role="option"]')[0]!)

    expect(box).toHaveValue('/help ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('keeps text after the caret like the @ menu', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    // one arrow left leaves 'd' waiting after the caret
    await user.type(box, '/mod{ArrowLeft}')
    await screen.findByRole('listbox', { name: 'Commands' })
    await user.tab()

    // the candidate replaces only the query, text after it survives
    expect(box).toHaveValue('/model d')
    expect(box.selectionStart).toBe('/model '.length)
  })

  it('space or newline closes the menu', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '/model x')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.clear(box)
    await user.type(box, '/a{Shift>}{Enter}{/Shift}')
    expect(box).toHaveValue('/a\n')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('shift enter stays a newline while open', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '/mo{Shift>}{Enter}{/Shift}')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(box).toHaveValue('/mo\n')
    // the newline ends the token, so the menu closed with it
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('leaves escaped and shell drafts alone', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '//literal')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.clear(box)
    await user.type(box, '!ls')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('the history search takes the keys over the menu', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '/mo')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()

    await user.keyboard('{Control>}r{/Control}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByText(/reverse-i-search/)).toBeInTheDocument()

    // closing the search does not bring the menu back over the draft
    await user.keyboard('zzz{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box).toHaveValue('/mo')
  })
})

describe('Composer Ctrl+J newline', () => {
  it('ctrl_j_inserts_a_newline_without_sending', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'line one')
    await user.keyboard('{Control>}j{/Control}')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(box.value).toBe('line one\n')
    // typing continues below the newline like after Shift+Enter
    await user.type(box, 'more')
    expect(box.value).toBe('line one\nmore')
  })

  it('cmd_j_inserts_a_newline_like_ctrl', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'line one')
    await user.keyboard('{Meta>}j{/Meta}')

    expect(box.value).toBe('line one\n')
  })

  it('inserts_at_the_caret_and_replaces_a_selection', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'ab')
    box.setSelectionRange(1, 1)
    await user.keyboard('{Control>}j{/Control}')

    expect(box.value).toBe('a\nb')
    // the caret sits after the newline, where typing continues
    expect(box.selectionStart).toBe(2)
    expect(box.selectionEnd).toBe(2)

    box.setSelectionRange(0, 1) // a selected range becomes the newline
    await user.keyboard('{Control>}j{/Control}')
    expect(box.value).toBe('\n\nb')
    expect(box.selectionStart).toBe(1)
  })

  it('ctrl_j_stands_down_while_the_menu_is_open', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', filesFetch({ ma: [{ path: 'src/main.go' }] }))
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @ma')
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    await user.keyboard('{Control>}j{/Control}')

    // the completion owns the keyboard, no newline slipped under it
    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeInTheDocument()
    expect(box.value).toBe('look at @ma')
  })

  it('leaves_ctrl_shift_j_to_the_browser', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    // Chrome and Firefox bind Ctrl+Shift+J to DevTools, so only the bare
    // modifier carries the newline
    await user.type(screen.getByLabelText('Prompt'), 'draft')
    await user.keyboard('{Control>}{Shift>}j{/Shift}{/Control}')

    expect(screen.getByLabelText('Prompt')).toHaveValue('draft')
  })

  it('counts_the_newline_as_an_edit_while_a_submit_is_pending', async () => {
    const user = userEvent.setup()
    let accept!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (accept = r))),
    )
    render(Harness())

    await user.type(screen.getByLabelText('Prompt'), 'hello{Enter}')
    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.keyboard('{Control>}j{/Control}')
    accept(Response.json({}, { status: 202 }))
    await act(async () => {}) // let the acceptance continuation run

    // like Shift+Enter, the newline is a draft edit an acceptance must keep
    expect(box).toHaveValue('hello\n')
  })
})

describe('Composer kill and yank keys', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ctrl_k kills to the line end and ctrl_y restores', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'one two')
    box.setSelectionRange(3, 3)
    await user.keyboard('{Control>}k{/Control}')
    expect(box.value).toBe('one')

    // the restore brings back the killed text with the pre-kill caret
    await user.keyboard('{Control>}y{/Control}')
    expect(box.value).toBe('one two')
    expect(box.selectionStart).toBe(3)
  })

  it('ctrl_u kills from the line start and parks the caret', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'one two')
    box.setSelectionRange(3, 3)
    await user.keyboard('{Control>}u{/Control}')
    expect(box.value).toBe(' two')
    expect(box.selectionStart).toBe(0)

    await user.keyboard('{Control>}y{/Control}')
    expect(box.value).toBe('one two')
    expect(box.selectionStart).toBe(3)
  })

  it('ctrl_k joins the line below across a newline', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'ab{Shift>}{Enter}{/Shift}cd')
    box.setSelectionRange(2, 2)
    await user.keyboard('{Control>}k{/Control}')
    expect(box.value).toBe('abcd')
  })

  it('ctrl_k joins the line above from a trailing empty line', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'one{Shift>}{Enter}{/Shift}')
    expect(box.value).toBe('one\n')
    await user.keyboard('{Control>}k{/Control}')
    expect(box.value).toBe('one')
    expect(box.selectionStart).toBe(0)
  })

  it('an empty kill keeps the older snapshot', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'one two')
    box.setSelectionRange(3, 3)
    await user.keyboard('{Control>}k{/Control}')
    expect(box.value).toBe('one')

    // the caret sits at the killed line's end: this kill removes nothing
    await user.keyboard('{Control>}k{/Control}')
    await user.keyboard('{Control>}y{/Control}')
    expect(box.value).toBe('one two')
  })

  it('typing after a kill drops the snapshot', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'one two')
    box.setSelectionRange(3, 3)
    await user.keyboard('{Control>}k{/Control}')
    await user.type(box, '!')
    await user.keyboard('{Control>}y{/Control}')

    // an edit dropped the snapshot, so the yank restores nothing
    expect(box.value).toBe('one!')
  })

  it('a kill counts as an edit while a submit is pending', async () => {
    const user = userEvent.setup()
    let accept!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (accept = r))),
    )
    render(Harness())

    await user.type(screen.getByLabelText('Prompt'), 'hello{Enter}')
    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    box.setSelectionRange(2, 2)
    await user.keyboard('{Control>}u{/Control}')
    accept(Response.json({}, { status: 202 }))
    await act(async () => {}) // let the acceptance continuation run

    // the kill is a deliberate edit an acceptance must keep
    expect(box.value).toBe('llo')
  })

  it('stands down behind the completion menus', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', filesFetch({ ma: [{ path: 'src/main.go' }] }))
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at @ma')
    await screen.findByRole('listbox', { name: 'Path suggestions' })
    await user.keyboard('{Control>}k{/Control}')

    // the menu owns the keyboard, nothing died under it
    expect(screen.getByRole('listbox', { name: 'Path suggestions' })).toBeInTheDocument()
    expect(box.value).toBe('look at @ma')

    await user.clear(box)
    await user.type(box, '/mo')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()
    await user.keyboard('{Control>}u{/Control}')
    expect(box.value).toBe('/mo')
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument()
  })

  it('stands down behind the history search', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'draft text')
    await user.keyboard('{Control>}r{/Control}')
    expect(screen.getByText(/reverse-i-search/)).toBeInTheDocument()

    // the unclaimed chord closes the overlay, the kill stays inert and the
    // draft survives untouched
    await user.keyboard('{Control>}k{/Control}')
    expect(screen.queryByText(/reverse-i-search/)).not.toBeInTheDocument()
    expect(box.value).toBe('draft text')
  })

  it('leaves meta and altgr chords with the browser', () => {
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'one two' } })
    box.setSelectionRange(3, 3)

    const meta = createEvent.keyDown(box, { key: 'k', metaKey: true })
    fireEvent(box, meta)
    expect(meta.defaultPrevented).toBe(false)

    const altgr = createEvent.keyDown(box, { key: 'k', ctrlKey: true, altKey: true })
    fireEvent(box, altgr)
    expect(altgr.defaultPrevented).toBe(false)
    expect(box.value).toBe('one two')
  })

  it('claims the chord even when a kill removes nothing', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'abc')
    box.setSelectionRange(0, 0)

    // Ctrl+U opens view source when it reaches the browser, an empty kill
    // must still claim the press
    const press = createEvent.keyDown(box, { key: 'u', ctrlKey: true })
    fireEvent(box, press)
    expect(press.defaultPrevented).toBe(true)
    expect(box.value).toBe('abc')
  })

  it('keeps its keys during IME composition', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'one two')
    box.setSelectionRange(3, 3)

    const press = createEvent.keyDown(box, { key: 'k', ctrlKey: true, isComposing: true })
    fireEvent(box, press)
    expect(press.defaultPrevented).toBe(false)
    expect(box.value).toBe('one two')
  })

  it('coarse chrome kills and restores the same', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness({ component: await coarseComposer() }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'one two')
    box.setSelectionRange(3, 3)
    await user.keyboard('{Control>}k{/Control}')
    expect(box.value).toBe('one')

    // the touch Enter rule stays a newline beside the chords
    await user.keyboard('{Control>}y{/Control}')
    expect(box.value).toBe('one two')
    expect(box.selectionStart).toBe(3)
    await user.keyboard('{Enter}')
    expect(box.value).toBe('one\n two')
  })
})

describe('Composer touch keyboard', () => {
  // Touch cases run on coarseComposer's re-import, every other test in this
  // file runs on the fine-pointer default the test setup ships.
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

  it('coarse_send_keeps_the_keyboard_up', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    const onSubmit = vi.fn()
    render(Harness({ component: await coarseComposer(), onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'one tap')

    // the press holds the textarea's focus, so the tap lands as one click
    // (never the ghost double-submit) and the keyboard stays open
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(box).toHaveFocus()

    await waitFor(() => expect(box).toHaveValue(''))
    expect(box).toHaveFocus() // ready for the next prompt
  })

  it('coarse_empty_send_dismisses_keyboard', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    const onSubmit = vi.fn()
    render(Harness({ component: await coarseComposer(), onSubmit }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    box.focus()
    const send = screen.getByRole('button', { name: 'Send' })

    // the empty draft keeps the button tappable with the disabled look, and
    // the tap closes the keyboard without submitting
    expect(send).toBeEnabled()
    expect(send).toHaveClass('keyboard-dismiss')
    await user.click(send)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(box).not.toHaveFocus()
  })

  it('coarse_host_disabled_send_stays_inert', async () => {
    render(
      Harness({
        component: await coarseComposer(),
        disabled: true,
        disabledReason: 'the stream is not live',
      }),
    )

    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).not.toHaveClass('keyboard-dismiss')
  })

  it('coarse_ctrl_j_inserts_a_newline', async () => {
    const user = userEvent.setup()
    render(Harness({ component: await coarseComposer() }))

    // the modifier newline works beside the touch Enter rule untouched
    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'line one')
    await user.keyboard('{Control>}j{/Control}')
    expect(box.value).toBe('line one\n')
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

  it('coarse_command_enter_accepts_not_sends', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    render(Harness({ component: await coarseComposer() }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '/mo{Enter}')

    // touch Enter accepts the highlighted command instead of sending
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(box).toHaveValue('/model ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
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

  it('fine_pointer_keeps_empty_send_disabled', () => {
    render(Harness())

    // desktop keeps today's inert Send over an empty draft
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('Composer fresh-tap focus', () => {
  it('first_tap_focuses_without_scroll', () => {
    render(Harness())

    // the early focus takes WebKit's keyboard reveal scroll out of play, so
    // the composer rests where the inset lift put it instead of panning away
    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    const spy = vi.spyOn(box, 'focus')
    fireEvent.pointerDown(box)
    expect(spy).toHaveBeenCalledWith({ preventScroll: true })
    expect(box).toHaveFocus()
  })

  it('focused_tap_keeps_native_caret', () => {
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    box.focus()
    const spy = vi.spyOn(box, 'focus')
    fireEvent.pointerDown(box)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('Composer submit flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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
    // acceptance clears, until then the draft stays exactly as typed
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(''))
  })

  it('mints ids where crypto.randomUUID is missing', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    // randomUUID is secure-context only: plain HTTP on a LAN IP, a supported
    // deployment, lacks it. Submit must still work there.
    vi.stubGlobal('crypto', {} as Crypto)
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), 'plain http{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(String(onSubmit.mock.calls[0]![1])).toMatch(/^p/)
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

  it('renders the stop control beside send and fires its click', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    )
    const onClick = vi.fn()
    const view = render(Harness({ stop: { onClick, busy: false } }))

    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(
      stop.compareDocumentPosition(screen.getByRole('button', { name: 'Send' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    await user.click(stop)
    expect(onClick).toHaveBeenCalledOnce()

    // an unanswered stop disables the button and says so
    view.unmount()
    render(Harness({ stop: { onClick, busy: true } }))
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
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
    expect(await screen.findByText(/not available right now/)).toBeInTheDocument()
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

  it('never resubmits a line another send left unanswered', async () => {
    const user = userEvent.setup()
    // deferred submits keep both sends on the wire until released in order
    const pending: ((res: Response) => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), 'alpha{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)

    // a different line may overlap an unanswered send
    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.clear(box)
    await user.type(box, 'beta{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(2)

    // alpha's reply lands while beta is still on the wire
    pending[0]!(Response.json({}, { status: 202 }))
    await act(async () => {}) // let alpha's completion run

    // an impatient Enter must not refire beta off alpha's completion
    await user.type(box, '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(2)

    // beta's own reply clears its marker and then the draft
    pending[1]!(Response.json({}, { status: 202 }))
    await act(async () => {})
    await waitFor(() => expect(box).toHaveValue(''))
    expect(onSubmit.mock.calls.map((c) => c[0])).toEqual(['alpha', 'beta'])
  })

  it('frees a refused line for an immediate retry', async () => {
    const user = userEvent.setup()
    let refused = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        refused
          ? Response.json({ error: 'busy' }, { status: 409 })
          : Response.json({}, { status: 202 }),
      ),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), 'retry me{Enter}')
    expect(await screen.findByText('Submit failed.')).toBeInTheDocument()

    refused = false
    await user.type(screen.getByLabelText('Prompt'), '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(''))
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
})

describe('Composer shell mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks a staged draft and reverts on edit', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    expect(screen.queryByTitle(stagedHint)).not.toBeInTheDocument()
    await user.type(box, '!go test ./...')

    expect(screen.getByTitle(stagedHint)).toHaveTextContent('!')
    expect(box.placeholder).toBe(stagedHint)
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()

    // clearing the prefix returns the composer to prompt presentation
    await user.clear(box)
    await user.type(box, 'try harder')
    expect(screen.queryByTitle(stagedHint)).not.toBeInTheDocument()
    expect(box.placeholder).toBe('Send a prompt — Enter to send, Shift+Enter for newline')
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('marks an excluded run with its own glyph and styling', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '!!echo hi')

    const chip = screen.getByTitle(excludedHint)
    expect(chip).toHaveTextContent('!!')
    expect(chip).toHaveClass('excluded')
    expect(box.placeholder).toBe(excludedHint)
  })

  it('keeps escaped and pasted drafts in prompt mode', async () => {
    const user = userEvent.setup()
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '//literal')
    expect(screen.queryByTitle(stagedHint)).not.toBeInTheDocument()
    expect(screen.queryByTitle(excludedHint)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()

    // a paste opening with a slash dispatches no command either
    await user.clear(box)
    await user.type(box, '/etc/hosts is stale{Shift>}{Enter}{/Shift}fix it')
    expect(screen.queryByTitle(stagedHint)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('paints optimistic rows for prompts ajent will commit', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    const box = screen.getByLabelText('Prompt')
    // `//x` reaches the model as the literal prompt `/x`, so it paints a row
    await user.type(box, '//literal{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit.mock.calls[0]![0]).toBe('//literal')

    // a multi-line paste opening with `/` is one verbatim prompt
    await user.type(box, '/etc/hosts{Shift>}{Enter}{/Shift}fix it{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]![0]).toBe('/etc/hosts\nfix it')
  })

  it('submits a shell line as-is from the Run button', async () => {
    const user = userEvent.setup()
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body && !(init.body instanceof FormData)) {
          bodies.push(JSON.parse(String(init.body)))
          return Response.json({}, { status: 202 })
        }
        return Response.json({})
      }),
    )
    const onSubmit = vi.fn()
    render(Harness({ onSubmit }))

    await user.type(screen.getByLabelText('Prompt'), '!ls -la')
    await user.click(screen.getByRole('button', { name: 'Run' }))

    expect(onSubmit).not.toHaveBeenCalled() // shell lines paint no pending row
    expect(bodies[0]).toMatchObject({ line: '!ls -la' })
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(''))
  })

  it('gives touch devices the same marker and Run label', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', okSubmit())
    render(Harness({ component: await coarseComposer() }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, '!ls')

    expect(screen.getByTitle(stagedHint)).toHaveTextContent('!')
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument()

    // the Run button stays the touch submit path
    await user.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(box).toHaveValue(''))
  })
})

describe('Composer attachments', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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

    // no upload call happened, the body landed in the draft fenced
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

  it('typing_during_upload_survives', async () => {
    const user = userEvent.setup()
    const upload = deferredUpload()
    vi.stubGlobal('fetch', upload.fetchSpy)
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'look at this')
    const file = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    await user.upload(screen.getByTestId('attach-input'), file)

    // only the paperclip disables, the draft keeps taking keystrokes while
    // the upload holds
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
    await user.type(box, ' while it uploads')
    expect(box.value).toBe('look at this while it uploads')

    upload.reply(Response.json({ path: '/state/shot.png' }))
    await act(async () => {}) // let the append continuation run

    // the ref lands under the live draft, not the selection-time one
    expect(box.value).toBe('look at this while it uploads\n\n@/state/shot.png')
  })

  it('recall_prefill_mid_upload_survives', async () => {
    const user = userEvent.setup()
    const upload = deferredUpload()
    vi.stubGlobal('fetch', upload.fetchSpy)
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'draft text')
    const file = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    await user.upload(screen.getByTestId('attach-input'), file)

    // the prefill lands through the host while the upload holds
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('retry{Enter}')
    expect(box.value).toBe('fix the retry loop\ndraft text')

    upload.reply(Response.json({ path: '/state/shot.png' }))
    await act(async () => {}) // let the append continuation run

    expect(box.value).toBe('fix the retry loop\ndraft text\n\n@/state/shot.png')
  })
})

describe('Composer image paste', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // pasted fakes the clipboardData a real paste carries, jsdom implements no
  // default paste, so only handler behavior is observable here.
  function pasted(target: HTMLElement, files: File[], text = '') {
    fireEvent.paste(target, { clipboardData: { getData: () => text, files } })
  }

  it('uploads a screenshot through the picker path', async () => {
    const uploads: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.body instanceof FormData) {
          uploads.push(init.body)
          return Response.json({ path: '/state/pasted.png' })
        }
        return Response.json({})
      }),
    )
    const onChange = vi.fn()
    render(Harness({ value: '', onChange }))

    const shot = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    pasted(screen.getByLabelText('Prompt'), [shot])

    await waitFor(() => expect(uploads).toHaveLength(1))
    expect(uploads[0]!.get('file')).toBeInstanceOf(File)
    // the reference lands exactly as a picked image's would
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('@/state/pasted.png'))
  })

  it('keeps a mixed clipboard pasting as text', async () => {
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    const onChange = vi.fn()
    render(Harness({ value: '', onChange }))

    // some apps ship a rendered thumbnail beside formatted text, the note
    // wins, so nothing uploads and this handler never touches the draft
    pasted(
      screen.getByLabelText('Prompt'),
      [new File(['png-bytes'], 'shot.png', { type: 'image/png' })],
      'copied note',
    )
    await act(async () => {})

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores images while the search overlay owns the composer', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(okSubmit())
    vi.stubGlobal('fetch', fetchSpy)
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt')
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    pasted(box, [new File(['png-bytes'], 'shot.png', { type: 'image/png' })])
    await act(async () => {})

    // the overlay keeps its paste rule and nothing uploads into the query
    expect(screen.getByText(/reverse-i-search/)).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// recallHarness wires the prepend rule exactly as the session hosts do, so
// acceptance tests can assert the merged draft and the handed-back caret.
function recallHarness(items: string[]) {
  const accept = vi.fn((text: string, current: string) => prependDraft(current, text))
  return { recall: { items, accept }, accept }
}

// mirrorHarness feeds a recall source that gains the workspace mirror's row
// when its refresh fires, the way useSessionCompose's fetch lands after
// Ctrl+R opened the search.
function MirrorHarness() {
  const [value, setValue] = useState('')
  const [items, setItems] = useState<readonly string[]>(['local one'])
  const recall: ComposerRecall = {
    items,
    accept: (text, current) => prependDraft(current, text),
    refresh: () => setItems(['local one', 'remote two']),
  }
  return (
    <Composer
      sessionId="01S"
      value={value}
      onChange={setValue}
      disabled={false}
      disabledReason=""
      onSubmit={() => {}}
      onSubmitFailed={() => {}}
      recall={recall}
    />
  )
}

describe('Composer history search', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens blank on ctrl_r with the draft intact', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'draft text')
    await user.keyboard('{Control>}r{/Control}')

    expect(screen.getByText(/reverse-i-search/)).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    // the line becomes the blank query while the search holds it, and the
    // stashed draft comes back when the search closes without a match
    expect(box).toHaveValue('')
    await user.keyboard('{Escape}')
    expect(box).toHaveValue('draft text')
  })

  it('narrows case-insensitively and enter accepts without sending', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(Harness({ onSubmit, ...recallHarness(['fix the retry loop', 'ship v2']) }))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('retry')

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('fix the retry loop')
    await user.keyboard('{Enter}')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.queryByText(/reverse-i-search/)).not.toBeInTheDocument()
    expect(box).toHaveValue('fix the retry loop')
    // the caret lands on the match occurrence, not the end
    expect(box.selectionStart).toBe(8)
    expect(box.selectionEnd).toBe(8)
  })

  it('the first escape accepts like enter', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('retry{Escape}')

    expect(screen.queryByText(/reverse-i-search/)).not.toBeInTheDocument()
    expect(box).toHaveValue('fix the retry loop')
  })

  it('escape without a match closes leaving the draft intact', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'my draft')
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('zzz')
    expect(screen.getByText('no match')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByText(/reverse-i-search/)).not.toBeInTheDocument()
    expect(box).toHaveValue('my draft')

    // a second Esc afterwards never clears or clobbers the draft
    await user.keyboard('{Escape}')
    expect(screen.queryByText(/reverse-i-search/)).not.toBeInTheDocument()
    expect(box).toHaveValue('my draft')
  })

  it('repeated ctrl_r steps to older matches and wraps', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['retry one', 'retry two'])))

    const box = screen.getByLabelText('Prompt')
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('retry')

    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Control>}r{/Control}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Control>}r{/Control}')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('arrows move the list highlight and enter accepts the move', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['alpha prompt', 'beta prompt', 'gamma prompt'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('prompt{ArrowDown}{ArrowDown}')
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}{Enter}')

    expect(box).toHaveValue('beta prompt')
  })

  it('accept merges above an existing draft through the prepend rule', async () => {
    const user = userEvent.setup()
    const h = recallHarness(['fix the retry loop'])
    render(Harness(h))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'my draft')
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('retry{Enter}')

    // the accepted text rides above, the existing draft below, with the
    // caret parked on the accepted match occurrence
    expect(box).toHaveValue('fix the retry loop\nmy draft')
    expect(box.selectionStart).toBe(8)
    expect(h.accept).toHaveBeenCalledWith('fix the retry loop', 'my draft')
  })

  it('caret falls back to the end when lowering shifts the offsets', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['İstanbul trip'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('i{Enter}')

    // İ lowers wider than itself, so no span is trusted and the caret parks
    // at the end, the same degradation the highlight takes
    expect(box).toHaveValue('İstanbul trip')
    expect(box.selectionStart).toBe(box.value.length)
  })

  it('paste joins the query without touching the draft', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    fireEvent.paste(box, { clipboardData: { getData: () => 'retry' } })

    expect(screen.getAllByRole('option')).toHaveLength(1)
    // the pasted text sits in the line as the query, and the empty draft is
    // what a close-without-accept restores
    expect(box).toHaveValue('retry')
  })

  it('an unclaimed key closes the overlay and proceeds', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    expect(screen.getByText(/reverse-i-search/)).toBeInTheDocument()

    // Ctrl+J is no filter key: the overlay closes and the newline lands
    await user.keyboard('{Control>}j{/Control}')
    expect(screen.queryByText(/reverse-i-search/)).not.toBeInTheDocument()
    expect(box).toHaveValue('\n')
  })

  it('backspace trims the query one character at a time', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['retry one', 'retry two'])))

    const box = screen.getByLabelText('Prompt')
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('retryy')

    // 'retryy' matched nothing, one backspace trims the trailing y and both
    // hits come back
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    await user.keyboard('{Backspace}')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('a mirror refresh landing under the search joins the matches', async () => {
    const user = userEvent.setup()
    render(<MirrorHarness />)

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}') // open fires the refresh
    await user.keyboard('two')

    // the swap refiltered under the open search, so the mirror's row matches
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(screen.getByRole('option')).toHaveTextContent('remote two')
  })

  it('virtual keyboard edits reach the query through change events', async () => {
    // virtual keyboards and IMEs deliver text as value changes, not claimed
    // keydowns: GBoard composition, autocorrect rewrites, iOS dictation
    const user = userEvent.setup()
    render(Harness(recallHarness(['fix the retry loop', 'ship v2'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')

    // a composition lands mid-IME with its full committed text at once
    fireEvent.change(box, { target: { value: 'retry' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)

    // autocorrect rewrites the word in place rather than appending
    fireEvent.change(box, { target: { value: 'ship' } })
    expect(screen.getByRole('option')).toHaveTextContent('ship v2')

    // a virtual backspace removes characters without a usable keydown
    fireEvent.change(box, { target: { value: 'shipp' } })
    expect(screen.getByText('no match')).toBeInTheDocument()

    // typing on restores the match and Enter accepts into the draft
    fireEvent.change(box, { target: { value: 'ship' } })
    await user.keyboard('{Enter}')
    expect(box).toHaveValue('ship v2')
  })
})

describe('Composer recall browsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('arrows browse from the newest entry after an accept', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['p3 newest', 'p2 middle', 'p1 oldest'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('p2{Enter}')
    expect(box).toHaveValue('p2 middle')

    // the first arrow revisits the list's newest entry, caret parked at end
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p3 newest')
    expect(box.selectionStart).toBe(box.value.length)

    // cursor-first: the caret reaches the prompt's start before history
    // steps, so walking older takes a reach-then-recall pair per entry
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p3 newest')
    expect(box.selectionStart).toBe(0)
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p2 middle')
    await user.keyboard('{ArrowUp}')
    expect(box.selectionStart).toBe(0)
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p1 oldest')
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p1 oldest') // already at the oldest

    // down walks back toward the live draft: the caret reaches the end
    // first, then each press steps newer until the held draft returns
    await user.keyboard('{ArrowDown}')
    expect(box).toHaveValue('p1 oldest')
    expect(box.selectionStart).toBe(box.value.length)
    await user.keyboard('{ArrowDown}')
    expect(box).toHaveValue('p2 middle')
    await user.keyboard('{ArrowDown}')
    expect(box).toHaveValue('p3 newest')
    await user.keyboard('{ArrowDown}')
    expect(box).toHaveValue('p2 middle')
  })

  it('up reaches the prompt start even without browsing', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['p3 newest', 'p2 middle'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'sitting draft')
    await user.keyboard('{ArrowUp}')

    // cursor-first like ajent: first row, mid-text, so the caret jumps to
    // the start and only the next press would recall
    expect(box).toHaveValue('sitting draft')
    expect(box.selectionStart).toBe(0)
  })

  it('up recalls from an empty draft', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['p3 newest', 'p2 middle'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p3 newest')

    // the held empty draft comes back at the list's end
    await user.keyboard('{ArrowDown}')
    expect(box).toHaveValue('')
  })

  it('a non-recall edit disarms and up re-arms at the newest', async () => {
    const user = userEvent.setup()
    render(Harness(recallHarness(['p3 newest', 'p2 middle', 'p1 oldest'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.click(box)
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('p2{Enter}{ArrowUp}')
    expect(box).toHaveValue('p3 newest')

    // typing pasted onto fresh content: the edit disarmed the browse, so up
    // first lands the caret at the start, then a fresh episode arms from the
    // list's newest entry, never resuming mid-list over the edited text
    await user.keyboard('x')
    expect(box).toHaveValue('p3 newestx')
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p3 newestx')
    expect(box.selectionStart).toBe(0)
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p3 newest')
    await user.keyboard('{ArrowUp}')
    expect(box.selectionStart).toBe(0)
    await user.keyboard('{ArrowUp}')
    expect(box).toHaveValue('p2 middle')
  })

  it('a recall fill survives an in-flight submit acceptance', async () => {
    const user = userEvent.setup()
    let acceptResponse!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (acceptResponse = r))),
    )
    render(Harness(recallHarness(['fix the retry loop'])))

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.type(box, 'hello{Enter}')
    await user.keyboard('{Control>}r{/Control}')
    await user.keyboard('retry{Enter}')
    // the match lands above the in-flight draft under the prepend rule
    expect(box).toHaveValue('fix the retry loop\nhello')

    acceptResponse(Response.json({}, { status: 202 }))
    await act(async () => {}) // let the acceptance continuation run

    // a recall fill is a deliberate edit: the acceptance clears nothing
    expect(box).toHaveValue('fix the retry loop\nhello')
  })
})

describe('Composer autosize cap', () => {
  it('caps at measured line boxes and re-measures on resize', async () => {
    render(Harness())

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    // jsdom computes inline styles back out, so an inline px line-height stands
    // in for the stylesheet, a stubbed scrollHeight plays overflow
    box.style.lineHeight = '30px'
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 9999 })

    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    // twelve measured rows cap at 360px, not the hardcoded 24px-per-row 288
    expect(box.style.height).toBe('360px')

    // a later resize re-measures: the cap follows the new line box
    box.style.lineHeight = '20px'
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(box.style.height).toBe('240px')
  })
})

describe('Composer history search on touch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers the same search from a toolbar button', async () => {
    const user = userEvent.setup()
    render(Harness({ component: await coarseComposer(), ...recallHarness(['fix the retry loop']) }))

    await user.click(screen.getByRole('button', { name: 'Search prompt history' }))
    expect(screen.getByText(/reverse-i-search/)).toBeInTheDocument()

    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    await user.keyboard('retry{Enter}')
    expect(box).toHaveValue('fix the retry loop')
    expect(screen.queryByText(/reverse-i-search/)).not.toBeInTheDocument()
  })

  it('fine pointers keep the toolbar clean', () => {
    render(Harness(recallHarness(['fix the retry loop'])))

    expect(screen.queryByRole('button', { name: 'Search prompt history' })).not.toBeInTheDocument()
  })
})
