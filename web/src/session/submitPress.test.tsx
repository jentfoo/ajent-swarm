import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSubmitPress } from './submitPress'
import { coarseImport } from '../test/matchMedia'

// The shared touch press behind every submit-beside-text button: the press
// holds the input's focus (user-event skips its press focus when mousedown
// stands prevented, the same contract browsers honor), and an empty draft's
// tap dismisses the keyboard instead of submitting.

// pressProbe builds the input-plus-submit-button shape every surface renders,
// closing over whichever gate instance it runs with.
function pressProbe(usePress: typeof useSubmitPress) {
  return function Probe({ empty }: { empty: boolean }): ReactElement {
    const inputRef = useRef<HTMLInputElement>(null)
    const [submits, setSubmits] = useState(0)
    const press = usePress(inputRef, empty, false)
    const onSubmit = (ev: FormEvent) => {
      ev.preventDefault()
      setSubmits((n) => n + 1)
    }
    return (
      <form onSubmit={onSubmit}>
        <input ref={inputRef} aria-label="Probe text" defaultValue={empty ? '' : 'typed'} />
        <output>{submits}</output>
        <button type="submit" disabled={press.disabled} {...press.handlers}>
          Send
        </button>
      </form>
    )
  }
}

const FineProbe = pressProbe(useSubmitPress)

// coarsePress re-imports the gate under the coarse-pointer stub, since it
// reads once at module scope.
async function coarsePress(): Promise<typeof useSubmitPress> {
  return (await coarseImport(() => import('./submitPress'))).useSubmitPress
}

describe('useSubmitPress', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('holds the input focused and submits on the tap', async () => {
    const user = userEvent.setup()
    const CoarseProbe = pressProbe(await coarsePress())
    render(<CoarseProbe empty={false} />)

    const input = screen.getByLabelText('Probe text')
    const send = screen.getByRole('button', { name: 'Send' })
    input.focus()

    // the suppressed press never claims focus, so the tap lands as one click
    // riding the form submit, and the keyboard stays up
    await user.click(send)
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(input).toHaveFocus()
  })

  it('dismisses the keyboard over an empty draft without submitting', async () => {
    const user = userEvent.setup()
    const CoarseProbe = pressProbe(await coarsePress())
    render(<CoarseProbe empty />)

    const input = screen.getByLabelText('Probe text')
    input.focus()
    expect(input).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(input).not.toHaveFocus() // the blur is the keyboard's dismissal
  })

  it('leaves fine pointer presses their default behavior', async () => {
    const user = userEvent.setup()
    render(<FineProbe empty={false} />)

    const send = screen.getByRole('button', { name: 'Send' })
    await user.click(send)
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(send).toHaveFocus() // the default press focus stays intact
  })

  it('keeps the empty fine pointer press disabled', () => {
    render(<FineProbe empty />)

    // desktop keeps today's inert Send over an empty draft
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})
