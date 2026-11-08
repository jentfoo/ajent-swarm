import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { FileSuggestion } from '../api/types'
import {
  currentMatch,
  matchOffset,
  openSearch,
  searchKey,
  withItems,
  type HistorySearch,
  type SearchKey,
} from './historySearch'
import { HistorySearchOverlay } from './HistorySearchOverlay'
import { atTokenBefore } from './atCompletion'
import { matchCommands, slashQuery, type CommandDoc } from './commands'
import { classifyLine } from './lineKind'

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

// stagedHint and excludedHint state shell staging: a `!` run's output rides
// the user's next message, a `!!` run never reaches the model. They swap in
// as the placeholder and label the marker glyph while a shell draft is up.
export const stagedHint = 'Shell run — output rides your next message'
export const excludedHint = 'Shell run — display only, never reaches the model'

// isTextFile reports whether a picked file should inline as text rather than
// upload. The type check comes first; extensions cover servers that skip it.
function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/') || file.type === 'application/json') return true
  return /\.(txt|md|json|toml|ya?ml|log|conf|cfg)$/.test(file.name)
}

// ComposerRecall wires the session's prompt recall into the composer. Items
// merge the committed typed prompts with the workspace-wide mirror, newest
// first and deduplicated; accept places a chosen prompt under the prepend
// rule (the path a rewind prefill uses, never clobbering a draft) and returns
// the draft it landed as so the caret can land inside the accepted text;
// refresh re-reads the workspace mirror, so a search opened later sees what
// other surfaces submitted since mount.
export interface ComposerRecall {
  items: readonly string[]
  accept: (text: string, current: string) => string
  refresh?: () => void
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
  // stop rides beside Send; the surface decides when a streaming turn shows it
  stop?: { onClick: () => void; busy: boolean }
  // prompt recall: the Ctrl+R history search and the arrows that browse its
  // list after an accept
  recall: ComposerRecall
}

// Composer is the prompt line: autosize textarea, Enter sends on fine
// pointers while Shift+Enter and Ctrl/Cmd+J insert newlines (touch inverts
// Enter to a newline and Send submits), with a client-minted pendingId for
// prompts (slash and shell lines submit as-is), and attachments upload under
// swarm's state directory dropping an @<abs path> reference, since submits
// are text-only. A draft opening with `!` or `!!` shows shell-mode
// affordances (marker, staging hint, Run label) mirroring ajent's dispatch.
export function Composer({
  sessionId,
  value,
  onChange,
  disabled,
  disabledReason,
  onSubmit,
  onSubmitFailed,
  stop,
  recall,
}: ComposerProps) {
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  // Ctrl+R reverse search over the session's recall source. The machine state
  // holds the list it opened with; every render refilters against the current
  // one, so a workspace mirror that lands under the open search joins the
  // matches without an effect (historySearch.withItems). null while closed;
  // the machine itself is pure (historySearch.ts).
  const [rawSearch, setRawSearch] = useState<HistorySearch | null>(null)
  const search =
    rawSearch === null || rawSearch.items === recall.items
      ? rawSearch
      : withItems(rawSearch, recall.items)
  const fileRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  // valueRef mirrors the controlled prop so the submit continuation compares
  // against what the composer holds now, not at send time. The layout effect
  // commits with its render, before a reply's task can interleave.
  const valueRef = useRef(value)
  // promptNav holds the armed arrow browse after a recall: the list snapshot,
  // the position inside it, the draft to restore at the end, and the text the
  // last recall step wrote. Every replacement that is not a recall step
  // disarms it — the value check below catches typing and sends, and host
  // fills that never cross the textarea's onChange (ajent's fragile-by-design
  // browsing rule: an edge arrow must never restore held state over fresh
  // content).
  const promptNav = useRef<{
    items: readonly string[]
    index: number
    stash: string
    expected: string
  } | null>(null)
  useLayoutEffect(() => {
    valueRef.current = value
    if (promptNav.current !== null && value !== promptNav.current.expected) promptNav.current = null
  })
  // typedSinceSend flags edits made while a submit is on the wire: an
  // acceptance must never clear them (a retype included).
  const typedSinceSend = useRef(false)
  // inFlight holds every unanswered submit's trimmed line, so an impatient
  // Enter cannot fire the same submission twice before its reply lands. One
  // marker per send: a completion clears only its own. Lines key it because
  // slash and shell submits mint no pendingId.
  const inFlight = useRef<Set<string>>(new Set())

  // Shell affordances follow the line ajent will see: the trimmed draft,
  // since submit trims. Marker, hint and the Run label track each keystroke
  // and stand down on an empty or escaped draft.
  const line = value.trim()
  const kind = classifyLine(line)
  const excluded = kind === 'shell-excluded'
  const shell = excluded || kind === 'shell'

  // While the search is open the textarea IS the query line, the way ajent's
  // TUI swaps the editor over: claimed keydowns feed the machine directly,
  // and everything a keyboard can deliver without a usable keydown (virtual
  // keys, IME composition, autocorrect) lands here as one value change.
  const shown = search !== null ? search.query : value

  // @-path completion: the caret's token drives a debounced files lookup.
  // Tab or an arrow-moved Enter accepts and drops the caret after the token;
  // a plain Enter sends as typed. The token is derived, so a closed menu never
  // holds stale state or intercepts keys.
  const [caret, setCaret] = useState(0)
  // suggestions tag their rows with the query they answered, so rows fetched
  // for an earlier token never render while the fresh lookup is debounced or
  // in flight, and fresh rows appear the moment they land.
  const [suggestions, setSuggestions] = useState<{ query: string; items: FileSuggestion[] } | null>(
    null,
  )
  // pick scopes the highlight and navigation to one menu query: a new query
  // derives fresh defaults, so no effect ever resets stale selection state.
  // Keys carry the menu's identity, so the @-menu and the command menu share
  // the one machine without colliding.
  const [pick, setPick] = useState({ key: '', index: 0, moved: false })
  const [dismissed, setDismissed] = useState<string | null>(null) // Escape hides one query
  const token = atTokenBefore(value, caret)
  const query = token?.query
  const items = suggestions !== null && suggestions.query === query ? suggestions.items : []
  const tokenKey = token !== null ? `at:${token.start}:${query}` : ''
  // slash-command completion rides the same key rules over a table held as
  // data (commands.ts): the menu opens the moment a line-initial `/` starts
  // the draft, narrows per keystroke, and never blocks a hand-typed line.
  const slash = slashQuery(value, caret)
  const commands = slash !== null ? matchCommands(slash) : []
  const slashKey = slash !== null ? `cmd:${slash}` : ''
  // the completion menus and the history search never show together: the
  // search claims the composer's keys until it closes, so a late files reply
  // cannot reopen a menu underneath it
  const atOpen = search === null && token !== null && items.length > 0 && tokenKey !== dismissed
  const commandOpen =
    search === null && slash !== null && commands.length > 0 && slashKey !== dismissed

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

  // Autosize with what the textarea displays, capped at a readable height.
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, maxRows * 24)}px`
  }, [shown])

  // One lookup per token query, debounced; failures leave the menu quiet.
  useEffect(() => {
    if (query === undefined) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      sessionAPI
        .files(sessionId, query, controller.signal)
        .then((res) => setSuggestions({ query, items: res.items ?? [] }))
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
      if (inFlight.current.has(line)) return
      // Shell runs and slash commands commit no message entry, so only
      // prompts paint an optimistic row; classification matches ajent's
      // dispatch, so an escaped or pasted `/`-opening prompt still paints.
      const isPrompt = classifyLine(line) === 'prompt'
      const pendingId = isPrompt ? newPendingID() : undefined
      if (pendingId !== undefined) onSubmit(line, pendingId)
      inFlight.current.add(line)
      typedSinceSend.current = false
      setError('')
      try {
        await sessionAPI.submit(sessionId, line, pendingId)
      } catch (err) {
        inFlight.current.delete(line)
        if (pendingId !== undefined) onSubmitFailed(pendingId)
        setError(err instanceof ApiError ? err.message : 'Submit failed.')
        return // the refused text stays right where it is
      }
      inFlight.current.delete(line)
      if (!typedSinceSend.current && valueRef.current === draft) onChange('')
    },
    [disabled, sessionId, onSubmit, onSubmitFailed, onChange],
  )

  // openSearchOverlay arms the blank Ctrl+R surface and refreshes the
  // workspace mirror, so cross-session prompts land under the search as they
  // arrive. The open completion menu is dismissed for its query so it cannot
  // reappear when the search closes without an accept: the overlays never
  // share the composer's keys.
  const openSearchOverlay = () => {
    setSuggestions(null)
    setPick({ key: '', index: 0, moved: false })
    setDismissed(menuKey)
    setRawSearch(openSearch(recall.items))
    recall.refresh?.()
    areaRef.current?.focus() // touch opens from a button; typing starts now
  }

  // applySearchKey feeds one machine key and resolves its outcome: accept
  // places the highlighted match, anything else updates the overlay state or
  // tears it down (the first Esc with no match closes only, draft untouched).
  const applySearchKey = (key: SearchKey): void => {
    const open = search
    if (open === null) return
    const { search: next, outcome } = searchKey(open, key)
    if (outcome === 'close') {
      setRawSearch(null)
      return
    }
    setRawSearch(next)
    if (outcome === 'accept') acceptSearchMatch(currentMatch(next)!, next.query)
  }

  // routeSearchKey maps one keydown onto the machine, reporting whether the
  // overlay claimed it. Unclaimed keys (a modified chord, PageUp) close the
  // overlay and fall through to the composer's own handling, ajent's
  // searchPass. Shift stays a text gesture: an uppercase rune joins the
  // query, while Shift+Enter passes through. A lone modifier press is not a
  // chord, so it never closes anything, and an IME mid-composition keeps its
  // keys while the overlay waits.
  const routeSearchKey = (ev: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (search === null || ev.nativeEvent.isComposing) return search !== null
    switch (ev.key) {
      case 'Shift':
      case 'Control':
      case 'Alt':
      case 'Meta':
        return true
    }
    let key: SearchKey | undefined
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      switch (ev.key) {
        case 'Enter':
          // Enter accepts without sending; the first Esc selects the same way
          if (!ev.shiftKey) key = { type: 'accept' }
          break
        case 'Escape':
          key = { type: 'accept' }
          break
        case 'Backspace':
          key = { type: 'backspace' }
          break
        case 'ArrowUp':
          if (!ev.shiftKey) key = { type: 'highlight', delta: -1 }
          break
        case 'ArrowDown':
          if (!ev.shiftKey) key = { type: 'highlight', delta: 1 }
          break
        default:
          if (ev.key.length === 1) key = { type: 'input', text: ev.key }
      }
    }
    if (key === undefined) {
      setRawSearch(null) // unclaimed: close and let the press proceed
      return false
    }
    ev.preventDefault()
    applySearchKey(key)
    return true
  }

  // acceptSearchMatch closes the overlay and places the match into the draft
  // through the host's prepend rule, the caret landing on the match
  // occurrence (falling back to the end when the offset cannot be located,
  // the same degradation the highlight takes). Arrow browsing restarts from
  // the list's newest entry after any accept.
  const acceptSearchMatch = (text: string, query: string) => {
    setRawSearch(null)
    const next = recall.accept(text, valueRef.current)
    const at = matchOffset(text, query)
    pendingSelectionRef.current = {
      text: next,
      caret: Math.min(at === -1 ? next.length : at, next.length),
    }
    typedSinceSend.current = true
    promptNav.current = null
  }

  // recallStep walks the armed list: delta 1 recalls older, -1 newer, and
  // past the newest the held draft comes back. Only an up arrow at the
  // draft's edge arms a fresh episode, always from the list's newest entry.
  const recallStep = (delta: 1 | -1): boolean => {
    let nav = promptNav.current
    if (nav === null) {
      if (delta !== 1 || recall.items.length === 0) return false
      nav = { items: recall.items, index: -1, stash: valueRef.current, expected: valueRef.current }
    }
    const at = nav.index + delta
    if (at >= nav.items.length) {
      promptNav.current = nav // already holding the oldest prompt
      return true
    }
    if (at < 0) {
      promptNav.current = null // the live buffer is back, the episode ends
      replaceDraft(nav.stash)
      return true
    }
    const text = nav.items[at]
    promptNav.current = { ...nav, index: at, expected: text }
    replaceDraft(text)
    return true
  }

  // replaceDraft applies one recall fill: the caret parks at the end like
  // every programmatic fill, and the replacement counts as a deliberate edit
  // an in-flight acceptance must keep.
  const replaceDraft = (text: string) => {
    pendingSelectionRef.current = { text, caret: text.length }
    typedSinceSend.current = true
    onChange(text)
  }

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

  // acceptCommand splices the chosen command over the slash query, the
  // trailing space ending the token — most commands take an argument, and the
  // next Enter submits. Returns the draft it produced so a moved Enter can
  // send it in one press.
  const acceptCommand = (cmd: CommandDoc): string => {
    if (slash === null) return value
    const insert = `/${cmd.name} `
    const next = `${insert}${value.slice(caret)}`
    pendingSelectionRef.current = { text: next, caret: insert.length }
    setCaret(insert.length)
    // a following Enter submits instead of completing again
    setPick({ key: '', index: 0, moved: false })
    onChange(next)
    return next
  }

  // One completion menu can be open at most: a line-initial `/` leaves no
  // whitespace an @ token needs before it, and an @ at line start leaves no
  // leading `/`. The key rules below run off these three values, so the two
  // menus can never drift apart.
  const menuKey = atOpen ? tokenKey : commandOpen ? slashKey : ''
  const menuCount = atOpen ? items.length : commandOpen ? commands.length : 0
  const acceptRow = (i: number): string =>
    atOpen ? accept(items[i] ?? items[0]) : acceptCommand(commands[i] ?? commands[0])
  const highlight = menuKey !== '' && pick.key === menuKey ? pick.index : 0
  const moved = menuKey !== '' && pick.key === menuKey && pick.moved

  // Stepping past the command menu's fold keeps the highlighted row visible,
  // the same guarantee the history search's list gives its cursor.
  const activeCommandRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (commandOpen) activeCommandRef.current?.scrollIntoView({ block: 'nearest' })
  }, [commandOpen, highlight])

  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+R opens the reverse search with preventDefault (it reloads on some
    // browsers); while it is open the same press steps to older matches, the
    // overlay's only stepping key.
    if (ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'r') {
      if (ev.nativeEvent.isComposing) return
      ev.preventDefault()
      if (search !== null) applySearchKey({ type: 'step-older' })
      else openSearchOverlay()
      return
    }
    if (search !== null && routeSearchKey(ev)) return
    if (menuKey !== '') {
      switch (ev.key) {
        case 'Tab':
          ev.preventDefault()
          acceptRow(highlight)
          return
        case 'ArrowDown':
          ev.preventDefault()
          setPick((p) => ({
            key: menuKey,
            index: Math.min(p.key === menuKey ? p.index + 1 : 1, menuCount - 1),
            moved: true,
          }))
          return
        case 'ArrowUp':
          ev.preventDefault()
          setPick((p) => ({
            key: menuKey,
            index: Math.max(p.key === menuKey ? p.index - 1 : 0, 0),
            moved: true,
          }))
          return
        case 'Enter':
          // Shift+Enter keeps its newline meaning while a menu is open. On
          // touch, Enter accepts the highlighted row so completion keeps
          // working without modifiers; on desktop a moved selection completes
          // first, then sends, and an un-moved one falls through to send as
          // typed (the TUI overlay's key rules).
          if (!ev.shiftKey && !ev.nativeEvent.isComposing) {
            ev.preventDefault()
            if (touchKeyboard) {
              acceptRow(highlight)
              return
            }
            if (moved) {
              void send(acceptRow(highlight))
              return
            }
          }
          break
        case 'Escape':
          ev.preventDefault()
          setDismissed(menuKey) // the same query stays hidden until it changes
          return
      }
    }
    // Ctrl/Cmd+J mirrors Shift+Enter's newline; Chrome, Firefox and Safari
    // deliver the press to the page. Ctrl+Shift+J (DevTools) and AltGr stay
    // with the browser; a completion menu and an IME mid-composition keep
    // their keys. The caret lands through pendingSelectionRef like accept()'s.
    if (
      menuKey === '' &&
      (ev.ctrlKey || ev.metaKey) &&
      !ev.altKey &&
      !ev.shiftKey &&
      ev.key.toLowerCase() === 'j'
    ) {
      if (ev.nativeEvent.isComposing) return
      ev.preventDefault()
      const el = ev.currentTarget
      const start = el.selectionStart ?? value.length
      const end = el.selectionEnd ?? value.length
      const next = `${value.slice(0, start)}\n${value.slice(end)}`
      pendingSelectionRef.current = { text: next, caret: start + 1 }
      setCaret(start + 1)
      typedSinceSend.current = true
      onChange(next)
      return
    }
    // Plain arrows browse the recall list, an episode always arming from its
    // newest entry — including right after a search accept. Cursor-first like
    // ajent: on the first visual row an Up
    // moves the caret to the prompt's start and only a press already on the
    // very first character recalls older; Down mirrors this at the end. A
    // recalled multi-line prompt is editable text whose caret must reach its
    // edge before the next step, and any edit landing a different draft
    // disarms the browse. Reaching here means a completion menu (which claims
    // arrows itself) is closed and the search is not.
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
      const el = ev.currentTarget
      const from = el.selectionStart
      if (from === el.selectionEnd && from !== null) {
        const firstBreak = value.indexOf('\n')
        const rowStart = value.lastIndexOf('\n') + 1
        if (ev.key === 'ArrowUp') {
          if (from === 0) {
            if (recallStep(1)) {
              ev.preventDefault()
              return
            }
          } else if (from <= (firstBreak === -1 ? value.length : firstBreak)) {
            // already on the first visual row: jump to the prompt's start
            ev.preventDefault()
            el.setSelectionRange(0, 0)
            return
          }
        } else if (ev.key === 'ArrowDown') {
          if (from === value.length) {
            if (recallStep(-1)) {
              ev.preventDefault()
              return
            }
          } else if (from >= rowStart) {
            // already on the last visual row: jump to the prompt's end
            ev.preventDefault()
            el.setSelectionRange(value.length, value.length)
            return
          }
        }
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
  // The append builds on the live draft (valueRef.current), not the
  // selection-time value: typing and prefills land during an upload.
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
        const draft = valueRef.current
        onChange(draft === '' ? refs.join('\n\n') : `${draft}\n\n${refs.join('\n\n')}`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Attach failed.')
      } finally {
        setUploading(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [sessionId, onChange],
  )

  return (
    <form className="composer" onSubmit={onFormSubmit}>
      {error && <p className="error-text">{error}</p>}
      <div className="composer-box">
        {atOpen && (
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
        {commandOpen && (
          <ul className="at-menu slash-menu" role="listbox" aria-label="Commands">
            {commands.map((cmd, i) => (
              <li key={cmd.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlight}
                  className={i === highlight ? 'active' : ''}
                  ref={i === highlight ? activeCommandRef : undefined}
                  onMouseDown={(ev) => {
                    ev.preventDefault() // the textarea keeps focus
                    acceptCommand(cmd)
                  }}
                  onMouseEnter={() => setPick({ key: slashKey, index: i, moved: true })}
                >
                  <span className="slash-name">/{cmd.name}</span>
                  <span className="slash-desc">{cmd.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {search !== null && (
          <HistorySearchOverlay
            search={search}
            onHighlight={(delta) => applySearchKey({ type: 'highlight', delta })}
            onAccept={(text) => acceptSearchMatch(text, search.query)}
            onClose={() => applySearchKey({ type: 'close' })}
          />
        )}
        {shell && (
          <span
            className={excluded ? 'composer-kind excluded' : 'composer-kind'}
            title={excluded ? excludedHint : stagedHint}
            aria-hidden="true"
          >
            {excluded ? '!!' : '!'}
          </span>
        )}
        <textarea
          ref={areaRef}
          rows={1}
          value={shown}
          placeholder={
            disabled
              ? disabledReason
              : excluded
                ? excludedHint
                : shell
                  ? stagedHint
                  : touchKeyboard
                    ? 'Send a prompt — Enter for newline, Send to submit'
                    : 'Send a prompt — Enter to send, Shift+Enter for newline'
          }
          aria-label="Prompt"
          disabled={disabled}
          onChange={(ev) => {
            if (search !== null) {
              applySearchKey({ type: 'replace', query: ev.target.value })
              return // the draft never changes while the search holds the keys
            }
            typedSinceSend.current = true
            onChange(ev.target.value)
          }}
          onPaste={(ev) => {
            // a paste joins the query, never the draft, while the search is open
            if (search === null) return
            ev.preventDefault()
            applySearchKey({ type: 'input', text: ev.clipboardData.getData('text') })
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
          {/* touch has no modifier keys, so the search rides the toolbar */}
          {touchKeyboard && (
            <button
              type="button"
              disabled={disabled}
              onClick={openSearchOverlay}
              aria-label="Search prompt history"
              title="Search prompt history"
            >
              🔍
            </button>
          )}
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
            aria-label="Attach files"
            title="Attach images or text files"
          >
            {uploading ? '…' : '📎'}
          </button>
          {/* stop rides beside Send, ahead of it in the touch order */}
          {stop && (
            <button type="button" onClick={stop.onClick} disabled={stop.busy}>
              {stop.busy ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <button className="primary" type="submit" disabled={disabled || line === ''}>
            {shell ? 'Run' : 'Send'}
          </button>
        </div>
      </div>
    </form>
  )
}

function newPendingID(): string {
  // randomUUID is secure-context only: plain HTTP over a LAN IP, a supported
  // deployment, lacks it, so fall back to a random hex correlation.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `p${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

// readInline renders one small text file as a fenced block with the filename
// prefixed above it; binary-looking bytes upload instead of landing garbage.
async function readInline(file: File): Promise<string> {
  const text = await file.text()
  if (text.includes('\u0000')) throw new Error(`${file.name} is not readable text`)
  return `\`${file.name}\`:\n\`\`\`\n${text.replace(/\n$/, '')}\n\`\`\``
}
