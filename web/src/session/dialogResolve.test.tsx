import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useDialogResolve } from './dialogResolve'

// One card's answer state: the dialog id rides every post, settled stays
// benign, refusals surface as the card's error line, and a busy card answers
// nothing twice.

function ResolveProbe({
  sessionId,
  dialogId,
  onAnsweredLocally,
}: {
  sessionId: string
  dialogId: number
  onAnsweredLocally: (dialogId: number) => void
}) {
  const { busy, error, resolve } = useDialogResolve(sessionId, dialogId, onAnsweredLocally)
  const [landed, setLanded] = useState('')
  return (
    <div>
      <span data-testid="busy">{String(busy)}</span>
      <span data-testid="error">{error}</span>
      <button
        type="button"
        onClick={() => void resolve({ index: 1 }).then((ok) => setLanded(String(ok)))}
      >
        answer
      </button>
      <span data-testid="landed">{landed}</span>
    </div>
  )
}

function stubFetch(respond: () => Response) {
  const bodies: unknown[] = []
  const spy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    return respond()
  })
  vi.stubGlobal('fetch', spy)
  return { spy, bodies }
}

// holdFetch stubs a post that hangs until released, pinning in-flight timing.
function holdFetch() {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const spy = vi.fn(async () => {
    await held
    return Response.json({ settled: false })
  })
  vi.stubGlobal('fetch', spy)
  return { release, spy }
}

describe('useDialogResolve', () => {
  it('posts the answer with the dialog id injected', async () => {
    const user = userEvent.setup()
    const { bodies } = stubFetch(() => Response.json({ settled: false }))
    const onAnsweredLocally = vi.fn()
    render(<ResolveProbe sessionId="01S" dialogId={7} onAnsweredLocally={onAnsweredLocally} />)

    await user.click(screen.getByRole('button', { name: 'answer' }))
    expect(bodies).toEqual([{ dialogId: 7, index: 1 }])
    expect(onAnsweredLocally).toHaveBeenCalledWith(7)
  })

  it('reports a landed answer as true', async () => {
    const user = userEvent.setup()
    stubFetch(() => Response.json({ settled: false }))
    render(<ResolveProbe sessionId="01S" dialogId={7} onAnsweredLocally={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'answer' }))
    expect(screen.getByTestId('landed')).toHaveTextContent('true')
  })

  it('treats a settled refusal as benign', async () => {
    const user = userEvent.setup()
    stubFetch(() =>
      Response.json({ error: 'settled', message: 'first answer won' }, { status: 409 }),
    )
    const onAnsweredLocally = vi.fn()
    render(<ResolveProbe sessionId="01S" dialogId={7} onAnsweredLocally={onAnsweredLocally} />)

    await user.click(screen.getByRole('button', { name: 'answer' }))
    expect(screen.getByTestId('error')).toHaveTextContent('')
    // a settled dialog is gone either way, so the answer reports as landed
    expect(screen.getByTestId('landed')).toHaveTextContent('true')
    expect(onAnsweredLocally).toHaveBeenCalledWith(7)
  })

  it('surfaces a refusal as the card error', async () => {
    const user = userEvent.setup()
    stubFetch(() =>
      Response.json({ error: 'busy', message: 'turn owns the loop' }, { status: 409 }),
    )
    const onAnsweredLocally = vi.fn()
    render(<ResolveProbe sessionId="01S" dialogId={7} onAnsweredLocally={onAnsweredLocally} />)

    await user.click(screen.getByRole('button', { name: 'answer' }))
    expect(screen.getByTestId('error')).toHaveTextContent('turn owns the loop')
    // ownership still lands: the dialog stays answerable, another surface's
    // settle may close it meanwhile
    expect(onAnsweredLocally).toHaveBeenCalledWith(7)
    // a refused answer reports as not landed so a caller can keep its draft
    expect(screen.getByTestId('landed')).toHaveTextContent('false')
  })

  it('marks ownership at submission, ahead of the response', async () => {
    const { release } = holdFetch()
    const onAnsweredLocally = vi.fn()
    render(<ResolveProbe sessionId="01S" dialogId={7} onAnsweredLocally={onAnsweredLocally} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'answer' }))
    // the settled frame can land while the post is still in flight, so the
    // ownership mark leads the response
    expect(onAnsweredLocally).toHaveBeenCalledWith(7)

    await act(async () => release())
    expect(onAnsweredLocally).toHaveBeenCalledTimes(1)
  })

  it('ignores a second answer while one is in flight', async () => {
    const { release, spy } = holdFetch()
    const onAnsweredLocally = vi.fn()
    render(<ResolveProbe sessionId="01S" dialogId={7} onAnsweredLocally={onAnsweredLocally} />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'answer' }))
    expect(screen.getByTestId('busy')).toHaveTextContent('true')
    await user.click(screen.getByRole('button', { name: 'answer' }))
    expect(spy).toHaveBeenCalledTimes(1)

    await act(async () => release())
    expect(screen.getByTestId('busy')).toHaveTextContent('false')
    expect(onAnsweredLocally).toHaveBeenCalledTimes(1)
  })
})
