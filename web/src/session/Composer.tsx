import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { FileSuggestion } from '../api/types'
import { atTokenBefore } from './atCompletion'

const maxRows = 12

// inlineFileCapBytes bounds a text attachment's inlined body; anything larger
// uploads and rides an @path reference instead.
const inlineFileCapBytes = 64 << 10

// textAccept lists the file picker's types: images ride the @path flow, text
// files inline into the draft as fenced blocks.
const textAccept = 'image/*,text/*,.json,.toml,.yaml,.yml,.md,.txt'

// touchKeyboard marks a touch-primary device, read once at module scope so key
// handling never re-evaluates it: a virtual keyboard has no Shift, so Enter
// means newline and the Send button submits.
const touchKeyboard = window.matchMedia('(pointer: coarse)').matches

// isTextFile reports whether a picked file should inline as text rather than
// upload. The type check comes first; extensions cover servers that skip it.
function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/') || file.type === 'application/json') return true
  return /\.(txt|md|json|toml|ya?ml|log|conf|cfg)$/.test(file.name)
}

// ComposerProps keeps the submit flow beside SessionView: it mints the
// pendingId, applies optimistic rows, and clears the draft only once the wire
// accepts a line — a refused one keeps its text (composer-draft-policy.md).
export interface ComposerProps {
  sessionId: string
  value: string // the controlled draft; recall fills it from above
  onChange: (text: string) => void
  disabled: boolean // a dialog holds input or the stream is not live
  disabledReason: string
  onSubmit: (line: string, pendingId: string) => void // paints the optimistic row
  onSubmitFailed: (pendingId: string) => void // a refused submit never queued
}

// Composer is the prompt line: autosize textarea, Enter sends on fine
// pointers and inserts a newline on touch ones (Send submits there), with a
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

  // valueRef mirrors the controlled prop so the submit continuation compares
  // against what the composer holds now, not at send time. The layout effect
  // commits with its render, before a reply's task can interleave.
  const valueRef = useRef(value)
  useLayoutEffect(() => {
    valueRef.current = value
  })
  // typedSinceSend flags edits made while a submit is on the wire: an
  // acceptance must never clear them (a retype included).
  const typedSinceSend = useRef(false)
  // inFlight names the line whose submit is unanswered, so an impatient Enter
  // cannot fire the same submission twice before its reply lands.
  const inFlight = useRef<string | null>(null)

  // @-path completion: the caret's token drives a debounced files lookup.
  // Tab or an arrow-moved Enter accepts and drops the caret after the token;
  // a plain Enter sends as typed. The token is derived, so a closed menu never
  // holds stale state or intercepts keys.
  const [caret, setCaret] = useState(0)
  const [items, setItems] = useState<FileSuggestion[]>([])
  // pick scopes the highlight and navigation to one token: a new token derives
  // fresh defaults, so no effect ever resets stale selection state.
  const [pick, setPick] = useState({ key: '', index: 0, moved: false })
  const [dismissed, setDismissed] = useState<string | null>(null) // Escape hides one query
  const token = atTokenBefore(value, caret)
  const menuOpen = token !== null && items.length > 0 && token.query !== dismissed
  const query = token?.query
  const tokenKey = `${token?.start}:${query}`
  const highlight = pick.key === tokenKey ? pick.index : 0
  const moved = pick.key === tokenKey && pick.moved

  // pendingSelection carries an accepted completion's caret across the
  // controlled value commit, which drops the DOM selection to end of text.
  const pendingSelectionRef = useRef<{ text: string; caret: number } | null>(null)
  useLayoutEffect(() => {
    const pending = pendingSelectionRef.current
    if (!pending) return
    pendingSelectionRef.current = null
    const el = areaRef.current
    // A superseded commit (e.g. a send cleared the draft in the same tick)
    // no longer owns the caret.
    if (!el || el.value !== pending.text) return
    const pos = Math.min(pending.caret, el.value.length)
    el.setSelectionRange(pos, pos)
  }, [value])

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

  // send submits one draft line: prompts mint the client pendingId that
  // paints an optimistic row; slash and shell lines submit as-is. The draft
  // stays put until the reply: a refusal keeps its text, and only acceptance
  // clears — and then solely when typing has not already reshaped it.
  const send = useCallback(
    async (draft: string) => {
      const line = draft.trim()
      if (line === '' || disabled) return
      if (inFlight.current === line) return
      // Slash and shell lines submit as-is: they surface through their effects
      // and commit no message entry, so only prompts paint an optimistic row.
      const isPrompt = !line.startsWith('/') && !line.startsWith('!')
      const pendingId = isPrompt ? newPendingID() : undefined
      if (pendingId !== undefined) onSubmit(line, pendingId)
      inFlight.current = line
      typedSinceSend.current = false
      setError('')
      try {
        await sessionAPI.submit(sessionId, line, pendingId)
      } catch (err) {
        inFlight.current = null
        if (pendingId !== undefined) onSubmitFailed(pendingId)
        setError(err instanceof ApiError ? err.message : 'Submit failed.')
        return // the refused text stays right where it is
      }
      inFlight.current = null
      if (!typedSinceSend.current && valueRef.current === draft) onChange('')
    },
    [disabled, sessionId, onSubmit, onSubmitFailed, onChange],
  )

  // accept replaces the token with the highlighted suggestion: directories
  // keep their separator so completion continues, files end the token. The
  // tracked caret and DOM selection land after the insertion (past a file's
  // trailing space) once the controlled commit reaches the textarea.
  const accept = useCallback(
    (suggestion: FileSuggestion): string => {
      if (token === null) return value
      const insert = `${suggestion.path}${suggestion.dir ? '' : ' '}`
      const nextCaret = token.start + 1 + insert.length
      const next = `${value.slice(0, token.start)}@${insert}${value.slice(caret)}`
      pendingSelectionRef.current = { text: next, caret: nextCaret }
      setCaret(nextCaret)
      // a following Enter submits instead of completing again
      setPick({ key: '', index: 0, moved: false })
      onChange(next)
      return next
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
          setPick((p) => ({
            key: tokenKey,
            index: Math.min(p.key === tokenKey ? p.index + 1 : 1, items.length - 1),
            moved: true,
          }))
          return
        case 'ArrowUp':
          ev.preventDefault()
          setPick((p) => ({
            key: tokenKey,
            index: Math.max(p.key === tokenKey ? p.index - 1 : 0, 0),
            moved: true,
          }))
          return
        case 'Enter':
          // Shift+Enter keeps its newline meaning while the menu is open. On
          // touch, Enter accepts the highlighted suggestion so completion
          // keeps working without modifiers; on desktop a moved selection
          // completes first, then sends, and an un-moved one falls through to
          // send as typed (the TUI overlay's key rules).
          if (!ev.shiftKey && !ev.nativeEvent.isComposing) {
            ev.preventDefault()
            if (touchKeyboard) {
              accept(items[highlight] ?? items[0])
              return
            }
            if (moved) {
              void send(accept(items[highlight] ?? items[0]))
              return
            }
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
    if (touchKeyboard) return // Enter stays a newline; the Send button submits
    ev.preventDefault()
    void send(value)
  }

  const onFormSubmit = (ev: FormEvent) => {
    ev.preventDefault()
    void send(value)
  }

  // Attachments ride the workaround: images upload under swarm's state dir
  // and the draft gains an @<abs path> reference for vision models to inject.
  // Small text files inline as fenced blocks instead, so context sees them
  // without a round trip; oversize or unreadable ones fall back to uploading.
  const attach = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setUploading(true)
      setError('')
      try {
        const refs: string[] = []
        for (const file of Array.from(files)) {
          if (isTextFile(file) && file.size <= inlineFileCapBytes) {
            refs.push(await readInline(file))
            continue
          }
          const res = await sessionAPI.attach(sessionId, file)
          refs.push(`@${res.path}`)
        }
        onChange(value === '' ? refs.join('\n\n') : `${value}\n\n${refs.join('\n\n')}`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Attach failed.')
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
                  onMouseEnter={() => setPick({ key: tokenKey, index: i, moved: true })}
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
            disabled
              ? disabledReason
              : touchKeyboard
                ? 'Send a prompt — Enter for newline, Send to submit'
                : 'Send a prompt — Enter to send, Shift+Enter for newline'
          }
          aria-label="Prompt"
          disabled={disabled}
          onChange={(ev) => {
            typedSinceSend.current = true
            onChange(ev.target.value)
          }}
          onKeyDown={onKeyDown}
          onSelect={(ev) => setCaret(ev.currentTarget.selectionStart ?? 0)}
        />
        {/* attach and send ride beside the prompt, not under it */}
        <div className="composer-actions">
          <input
            ref={fileRef}
            type="file"
            accept={textAccept}
            multiple
            hidden
            data-testid="attach-input"
            onChange={(ev) => void attach(ev.target.files)}
          />
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
            aria-label="Attach files"
            title="Attach images or text files"
          >
            {uploading ? '…' : '📎'}
          </button>
          <button className="primary" type="submit" disabled={disabled || value.trim() === ''}>
            Send
          </button>
        </div>
      </div>
    </form>
  )
}

function newPendingID(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  // Very old engines: a random hex correlation is still unique enough here.
  return `p${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

// readInline renders one small text file as a fenced block with the filename
// prefixed above it; binary-looking bytes upload instead of landing garbage.
async function readInline(file: File): Promise<string> {
  const text = await file.text()
  if (text.includes('\u0000')) throw new Error(`${file.name} is not readable text`)
  return `\`${file.name}\`:\n\`\`\`\n${text.replace(/\n$/, '')}\n\`\`\``
}
