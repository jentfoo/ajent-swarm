import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { prependDraft, readDraft, resetDrafts, writeDraft } from './draftStore'

// readStored parses what persistence actually wrote; null when nothing did.
function readStored(): unknown {
  const raw = localStorage.getItem('swarm.drafts.v1')
  return raw === null ? null : JSON.parse(raw)
}

describe('draftStore', () => {
  beforeEach(() => {
    localStorage.clear()
    resetDrafts()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes a draft and reads it back', () => {
    expect(readDraft('01A')).toBe('')
    writeDraft('01A', 'fix the bug')
    expect(readDraft('01A')).toBe('fix the bug')
  })

  it('keeps sessions isolated by id', () => {
    writeDraft('01A', 'alpha')
    writeDraft('01B', 'beta')
    expect(readDraft('01A')).toBe('alpha')
    expect(readDraft('01B')).toBe('beta')

    // a second write for one session leaves the other untouched
    writeDraft('01A', 'gamma')
    expect(readDraft('01B')).toBe('beta')
  })

  it('clears on an empty write and survives a remount read', () => {
    writeDraft('01A', 'alpha')
    writeDraft('01A', '')
    expect(readDraft('01A')).toBe('')
    resetDrafts() // re-read what storage actually holds
    expect(readDraft('01A')).toBe('')
  })

  it('reloads drafts written by an earlier page load', () => {
    writeDraft('01A', 'alpha')
    resetDrafts()
    expect(readDraft('01A')).toBe('alpha')
  })

  it('reads corrupt storage as fresh', () => {
    localStorage.setItem('swarm.drafts.v1', '{not json')
    resetDrafts()
    expect(readDraft('01A')).toBe('')
  })

  it('ignores non-string values in storage', () => {
    localStorage.setItem('swarm.drafts.v1', JSON.stringify({ '01A': 42, '01B': 'beta' }))
    resetDrafts()
    expect(readDraft('01A')).toBe('')
    expect(readDraft('01B')).toBe('beta')
  })

  it('skips persisting oversize drafts instead of truncating', () => {
    // in-memory reads still work within this page load
    writeDraft('01A', 'x'.repeat(512 * 1024 + 1))
    expect(readDraft('01A')).toBe('x'.repeat(512 * 1024 + 1))
    // a reload finds nothing: persistence was skipped, never truncated
    resetDrafts()
    expect(readDraft('01A')).toBe('')
  })

  it('drops the stored copy once a draft grows past the cap', () => {
    writeDraft('01A', 'stale older text')
    expect(readStored()).toEqual({ '01A': 'stale older text' })

    writeDraft('01A', 'x'.repeat(512 * 1024 + 1))
    // the oversize text is memory-only, so its smaller predecessor must not
    // linger: a reload would otherwise restore it as if current
    expect(readStored()).toEqual({})
    resetDrafts()
    expect(readDraft('01A')).toBe('')
  })

  it('keeps other sessions persisting while one draft is oversize', () => {
    writeDraft('01A', 'x'.repeat(512 * 1024 + 1))
    writeDraft('01B', 'beta')
    // the runaway draft never rides in through another session's write
    expect(readStored()).toEqual({ '01B': 'beta' })
    resetDrafts()
    expect(readDraft('01A')).toBe('')
    expect(readDraft('01B')).toBe('beta')
  })

  it('survives quota failures and recovers on a later write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded')
    })
    expect(() => writeDraft('01A', 'kept in memory')).not.toThrow()
    expect(readDraft('01A')).toBe('kept in memory')

    vi.mocked(Storage.prototype.setItem).mockRestore()
    writeDraft('01B', 'beta')
    // the recovered write carries every draft persistence may still hold
    expect(readStored()).toEqual({ '01A': 'kept in memory', '01B': 'beta' })
  })
})

describe('prependDraft', () => {
  it('takes the whole buffer when the draft is empty', () => {
    expect(prependDraft('', 'recalled')).toBe('recalled')
  })

  it('lands above a non-empty draft behind one newline', () => {
    expect(prependDraft('my draft', 'recalled')).toBe('recalled\nmy draft')
  })
})
