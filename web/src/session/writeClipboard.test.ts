import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeClipboard } from './writeClipboard'

// jsdom ships no clipboard and no execCommand; each file stubs them so the
// requirement stays visible at the call sites it covers
function stubClipboard(writeText: (text: string) => Promise<void>) {
  const fn = vi.fn(writeText)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: fn } })
  return fn
}

function stubExecCommand(ok: boolean) {
  // capture the textarea contents at command time, before the helper removes it
  let copied: string | undefined
  const commands = vi.fn(() => {
    copied = document.querySelector('textarea')?.value
    return ok
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: commands })
  return { commands, copiedText: () => copied }
}

function unstub() {
  delete (navigator as { clipboard?: unknown }).clipboard
  delete (document as { execCommand?: unknown }).execCommand
}

afterEach(unstub)

describe('writeClipboard', () => {
  it('prefers the async clipboard api', async () => {
    const writes = stubClipboard(async () => {})
    const { commands } = stubExecCommand(true)

    await expect(writeClipboard('raw markdown')).resolves.toBeUndefined()
    expect(writes).toHaveBeenCalledWith('raw markdown')
    expect(commands).not.toHaveBeenCalled()
  })

  it('falls back to exec command after a rejection', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))
    const { commands, copiedText } = stubExecCommand(true)

    await expect(writeClipboard('raw markdown')).resolves.toBeUndefined()
    expect(commands).toHaveBeenCalledTimes(1)
    expect(copiedText()).toBe('raw markdown')
  })

  it('falls back to exec command with no clipboard', async () => {
    const { commands, copiedText } = stubExecCommand(true)

    await expect(writeClipboard('raw markdown')).resolves.toBeUndefined()
    expect(commands).toHaveBeenCalledTimes(1)
    expect(copiedText()).toBe('raw markdown')
  })

  it('reports failure when every path fails', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))
    stubExecCommand(false)

    await expect(writeClipboard('raw markdown')).rejects.toThrow()
  })

  it('removes the fallback textarea afterwards', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))
    stubExecCommand(true)

    await writeClipboard('raw markdown')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
