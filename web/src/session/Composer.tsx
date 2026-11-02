import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { FileSuggestion } from '../api/types'
import { atTokenBefore } from './atCompletion'

const maxRows = 12

// ComposerProps keeps the submit flow beside SessionView: it mints the
// pendingId, applies optimistic rows and clears the draft only on acceptance.
export interface ComposerProps {
  sessionId: string
  value: string // the controlled draft; recall fills it from above
  onChange: (text: string) => void
  disabled: boolean // a dialog holds input or the stream is not live
  disabledReason: string
  onSubmit: (line: string, pendingId: string) => void // paints the optimistic row
  onSubmitFailed: (pendingId: string) => void // a refused submit never queued
}

// Composer is the prompt line: autosize textarea, Enter sends with a
// client-minted pendingId for prompts (slash and shell lines submit as-is),
// and attachments upload under swarm's state directory dropping an
// @<abs path> reference, since submits are text-only.
export function Composer({
  sessionId,
  value,
  onChange,
  disabled,
  disabledReason,
  onSubmit,
  onSubmitFailed,
}: ComposerProps) {
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // @-path completion: the caret's token drives a debounced files lookup,
  // Tab accepts and arrows move the highlight. The token is derived, so a
  // closed menu never holds stale state or intercepts keys.
  const [caret, setCaret] = useState(0)
  const [items, setItems] = useState<FileSuggestion[]>([])
  const [highlight, setHighlight] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null) // Escape hides one query
  const token = atTokenBefore(value, caret)
  const menuOpen = token !== null && items.length > 0 && token.query !== dismissed
  const query = token?.query

  // Autosize with the draft, capped at a readable height.
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxRows * 24)}px`
  }, [value])

  // One lookup per token query, debounced; failures leave the menu quiet and
  // stale rows never render because an absent token closes it.
  useEffect(() => {
    if (query === undefined) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      sessionAPI
        .files(sessionId, query, controller.signal)
        .then((res) => setItems(res.items ?? []))
        .catch(() => {}) // a failed lookup just leaves the menu quiet
    }, 120)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, query])

  const send = useCallback(async () => {
    const line = value.trim()
    if (line === '' || disabled) return
    // Slash and shell lines submit as-is: they surface through their effects
    // and commit no message entry, so only prompts paint an optimistic row.
    const isPrompt = !line.startsWith('/') && !line.startsWith('!')
    const pendingId = isPrompt ? newPendingID() : undefined
    if (pendingId !== undefined) onSubmit(line, pendingId)
    onChange('')
    setError('')
    try {
      await sessionAPI.submit(sessionId, line, pendingId)
    } catch (err) {
      if (pendingId !== undefined) onSubmitFailed(pendingId)
      setError(err instanceof ApiError ? err.message : 'Submit failed.')
    }
  }, [value, disabled, sessionId, onSubmit, onSubmitFailed, onChange])

  // accept replaces the token with the highlighted suggestion: directories
  // keep their separator so completion continues, files end the token.
  const accept = useCallback(
    (suggestion: FileSuggestion) => {
      if (token === null) return
      const tail = value.slice(caret)
      const next = `${value.slice(0, token.start)}@${suggestion.path}${
        suggestion.dir ? '' : ' '
      }${tail}`
      setCaret(token.start + 1 + suggestion.path.length)
      onChange(next)
    },
    [token, value, caret, onChange],
  )

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      switch (ev.key) {
        case 'Tab':
          ev.preventDefault()
          accept(items[highlight] ?? items[0])
          return
        case 'ArrowDown':
          ev.preventDefault()
          setHighlight((h) => Math.min(h + 1, items.length - 1))
          return
        case 'ArrowUp':
          ev.preventDefault()
          setHighlight((h) => Math.max(h - 1, 0))
          return
        case 'Enter': // completing a path wins over sending the draft
          if (!ev.nativeEvent.isComposing) {
            ev.preventDefault()
            accept(items[highlight] ?? items[0])
            return
          }
          break
        case 'Escape':
          ev.preventDefault()
          setDismissed(token.query) // the same query stays hidden until it changes
          return
        default:
      }
    }
    if (ev.key !== 'Enter' || ev.shiftKey) return
    if (ev.nativeEvent.isComposing) return // an IME mid-composition is not a send
    ev.preventDefault()
    void send()
  }

  const onFormSubmit = (ev: FormEvent) => {
    ev.preventDefault()
    void send()
  }

  // Attachments ride the workaround: bytes land under swarm's state dir and
  // the draft gains an @<abs path> reference for vision models to inject.
  const attach = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setUploading(true)
      setError('')
      try {
        const refs: string[] = []
        for (const file of Array.from(files)) {
          const res = await sessionAPI.attach(sessionId, file)
          refs.push(`@${res.path}`)
        }
        onChange(value === '' ? refs.join('\n') : `${value}\n${refs.join('\n')}`)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Attach failed.')
      } finally {
        setUploading(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [sessionId, value, onChange],
  )

  return (
    <form className="composer" onSubmit={onFormSubmit}>
      {error && <p className="error-text">{error}</p>}
      <div className="composer-box">
        {menuOpen && (
          <ul className="at-menu" role="listbox" aria-label="Path suggestions">
            {items.map((item, i) => (
              <li key={item.path}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  className={i === highlight ? 'active' : ''}
                  onMouseDown={(ev) => {
                    ev.preventDefault() // the textarea keeps focus
                    accept(item)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  {item.path}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={areaRef}
          rows={1}
          value={value}
          placeholder={
            disabled ? disabledReason : 'Send a prompt — Enter to send, Shift+Enter for newline'
          }
          aria-label="Prompt"
          disabled={disabled}
          onChange={(ev) => onChange(ev.target.value)}
          onKeyDown={onKeyDown}
          onSelect={(ev) => setCaret(ev.currentTarget.selectionStart ?? 0)}
        />
      </div>
      <div className="composer-actions">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="attach-input"
          onChange={(ev) => void attach(ev.target.files)}
        />
        <button
          type="button"
          disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? 'Attaching…' : '+ image'}
        </button>
        <button className="primary" type="submit" disabled={disabled || value.trim() === ''}>
          Send
        </button>
      </div>
    </form>
  )
}

function newPendingID(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  // Very old engines: a random hex correlation is still unique enough here.
  return `p${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}
