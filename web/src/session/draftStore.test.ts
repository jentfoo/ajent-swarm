import { beforeEach, describe, expect, it } from 'vitest'

import { prependDraft, readDraft, resetDrafts, writeDraft } from './draftStore'

describe('draftStore', () => {
  beforeEach(() => {
    localStorage.clear()
    resetDrafts()
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
})

describe('prependDraft', () => {
  it('takes the whole buffer when the draft is empty', () => {
    expect(prependDraft('', 'recalled')).toBe('recalled')
  })

  it('lands above a non-empty draft behind one newline', () => {
    expect(prependDraft('my draft', 'recalled')).toBe('recalled\nmy draft')
  })
})
