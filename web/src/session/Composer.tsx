import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent, KeyboardEvent, PointerEvent } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import type { FileSuggestion } from '../api/types'
import { MenuPopover } from '../ui/MenuPopover'
import { AttachIcon, CheckIcon, CircleXIcon, CloseIcon, SearchIcon } from '../ui/icons'
import { sessionDrag, useSessionDrag } from '../ui/dndContext'
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
import { pasteImageFiles } from './pasteImages'
import { killLineEnd, killLineStart, yank } from './editKeys'
import type { EditState, KillSnapshot } from './editKeys'
import { useSubmitPress, touchKeyboard } from './submitPress'
import { Spinner } from './Spinner'

// maxRows and minRows bound the autosize cap, capShare of the visible viewport
// in line boxes picking the count between them: a tall window keeps every row,
// a phone with its keyboard open leaves the transcript the rest.
const maxRows = 12
const minRows = 4
const capShare = 0.3

// fallbackRowPx degrades the cap when computed styles are unreadable: the
// coarse-pointer line box (16px font x 1.5), today's constant.
const fallbackRowPx = 24

// inlineFileCapBytes bounds a text attachment's inlined body, anything
// larger uploads as an @path reference instead.
const inlineFileCapBytes = 64 << 10

// attachConcurrency caps the uploads in flight at once: a local service takes
// a few parallel posts, dozens at once would burst.
const attachConcurrency = 3

// textExts are the extensions that read as text whatever MIME the browser
// reports for them: source files often arrive with an empty file.type.
const textExts = [
  'cfg',
  'conf',
  'css',
  'go',
  'html',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'py',
  'rs',
  'sh',
  'sql',
  'toml',
  'ts',
  'tsx',
  'txt',
  'yaml',
  'yml',
]

// textAccept lists the file picker's types: images ride the @path flow, text
// files inline into the draft as fenced blocks.
const textAccept = `image/*,text/*,${textExts.map((ext) => `.${ext}`).join(',')}`

const textExtRe = new RegExp(`\\.(${textExts.join('|')})$`, 'i')

// SubmitVerb names the composer's two submit verbs, each guarding its own
// in-flight set: a sent copy and a parked one are distinct actions.
type SubmitVerb = 'send' | 'queue'

// submitWire routes every verb onto its endpoint, both sharing one body shape.
const submitWire: Record<SubmitVerb, typeof sessionAPI.submit> = {
  send: sessionAPI.submit,
  queue: sessionAPI.queue,
}

// stagedHint and excludedHint state shell staging: a `!` run's output rides
// the user's next message, a `!!` run never reaches the model. They swap in
// as the placeholder and label the marker glyph while a shell draft is up.
export const stagedHint = 'Shell run — output rides your next message'
export const excludedHint = 'Shell run — display only, never reaches the model'

// isTextFile reports whether a picked file should inline as text rather than
// upload. Extension covers servers that skip the type check.
function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/') || file.type === 'application/json') return true
  return textExtRe.test(file.name)
}

// UploadStatus is one attachment's lifecycle: queued behind the concurrency
// limit, on the wire, landed, or refused.
type UploadStatus = 'pending' | 'uploading' | 'done' | 'failed'

// UploadItem is one attachment chip: the file's name, its state and the @path
// an upload landed at, absent for a file inlined into the draft.
interface UploadItem {
  id: string
  name: string
  status: UploadStatus
  reference?: string
}

// UploadOutcome settles one file: the reference it landed, the copy of its
// refusal, or neither when its chip was dropped before the turn came.
type UploadOutcome =
  { name: string; reference: string } | { name: string; error: string } | { name: string }

// uploadWords names each chip's state for sighted readers, never a progress
// percentage: the endpoint reports none.
const uploadWords: Record<UploadStatus, string> = {
  pending: 'Queued',
  uploading: 'Uploading',
  done: 'Attached',
  failed: 'Failed',
}

// viewportHeight reports the height the composer can be seen in: the visual
// viewport excludes a phone keyboard, innerHeight stands in without one.
function viewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight
}

// ComposerRecall wires the session's prompt recall into the composer. Items
// merge committed typed prompts with the workspace-wide mirror, newest first
// and deduplicated, holding one array reference until the contents change:
// an open search refilters any new reference and restarts at its newest hit.
// Accept places a chosen prompt under the prepend rule (the rewind prefill
// path, never clobbering a draft) and returns the landed draft for caret
// placement. Refresh re-reads the workspace mirror so a later search sees
// what other surfaces submitted since mount.
export interface ComposerRecall {
  items: readonly string[]
  accept: (text: string, current: string) => string
  refresh: () => void
}

// ComposerProps keeps the submit flow beside SessionView: it mints the
// pendingId, applies optimistic rows, and clears the draft only once the wire
// accepts a line, a refused one keeps its text (composer-draft-policy.md).
export interface ComposerProps {
  sessionId: string
  value: string // the controlled draft; recall fills it from above
  onChange: (text: string) => void
  disabled: boolean // a dialog holds input or the stream is not live
  disabledReason: string
  onSubmit: (line: string, pendingId: string) => void // paints the optimistic row
  onSubmitFailed: (pendingId: string) => void // a refused submit never queued
  // onQueue parks the line for the session's next idle point, painting the
  // same optimistic row in its parked state
  onQueue: (line: string, pendingId: string) => void
  onQueueFailed: (pendingId: string) => void
  // stop rides beside Send, the surface decides when a streaming turn shows it
  stop?: { onClick: () => void; busy: boolean }
  // prompt recall: the Ctrl+R history search and the arrows that browse its
  // list after an accept
  recall: ComposerRecall
  // chainInto wires the composer's chain drop strip: another session's drag
  // drops here to open the chain dialog with the dragged session queued
  // after this one; nameFor labels the dragged session. Absent leaves no
  // strip rendered.
  chainInto?: { nameFor: (sessionId: string) => string; open: (childId: string) => void }
}

// Composer is the prompt line: autosize textarea, Enter sends on fine
// pointers while Shift+Enter and Ctrl/Cmd+J insert newlines and Ctrl+K/U/Y
// kill and yank logical lines like the TUI editor (touch inverts
// Enter to a newline and Send submits), with a client-minted pendingId for
// prompts (slash and shell lines submit as-is), and attachments upload under
// swarm's state directory dropping an @<abs path> reference, since submits
// are text-only. A draft opening with `!` or `!!` shows shell-mode
// affordances (marker, staging hint, Run label) mirroring ajent's dispatch.
// Queue parks the draft beside Send, holding it in swarm until the
// session's provider has been idle for the park window before the same
// submit runs.
export function Composer({
  sessionId,
  value,
  onChange,
  disabled,
  disabledReason,
  onSubmit,
  onSubmitFailed,
  onQueue,
  onQueueFailed,
  stop,
  recall,
  chainInto,
}: ComposerProps) {
  // submitError and attachError stay apart: a refused submit marks the prompt
  // invalid and describes the field, a failed attach names its files and
  // leaves the prompt alone.
  const [submitError, setSubmitError] = useState('')
  const [attachError, setAttachError] = useState('')
  // uploads tracks the current batch's chips, the next batch replaces them
  const [uploads, setUploads] = useState<UploadItem[]>([])
  // attaching flags a batch on the wire for the paperclip, attachingRef is
  // the synchronous guard: the picker, a paste and a drop all reach attach
  // before the state could re-render
  const [attaching, setAttaching] = useState(false)
  const attachingRef = useRef(false)
  // removedUploads drops a queued chip before its turn: the pool reads it when
  // that file would start
  const removedUploads = useRef(new Set<string>())
  const submitErrorId = useId()
  const attachErrorId = useId()
  // clearErrors drops both messages with the edit that answers them
  const clearErrors = useCallback(() => {
    setSubmitError('')
    setAttachError('')
  }, [])

  const setUpload = useCallback((id: string, status: UploadStatus, reference?: string) => {
    setUploads((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, status, reference: reference ?? item.reference } : item,
      ),
    )
  }, [])

  // Ctrl+R reverse search over the session's recall source. The machine state
  // holds the list it opened with, every render refilters against the current
  // one, so a workspace mirror landing under an open search joins the matches
  // without an effect (historySearch.withItems). null while closed.
  const [rawSearch, setRawSearch] = useState<HistorySearch | null>(null)
  const search =
    rawSearch === null || rawSearch.items === recall.items
      ? rawSearch
      : withItems(rawSearch, recall.items)
  const fileRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // composer-box anchors every popup layer the form portals through MenuPopover
  const boxRef = useRef<HTMLDivElement>(null)

  // valueRef mirrors the controlled prop so the submit continuation compares
  // against what the composer holds now, not at send time. The layout effect
  // commits with its render, before a reply's task can interleave.
  const valueRef = useRef(value)
  // promptNav holds the armed arrow browse after a recall: the list snapshot,
  // the position inside it, the draft to restore at the end, and the text the
  // last recall step wrote. Every non-recall replacement disarms it via the
  // value check below (ajent's fragile-by-design browsing rule: an edge arrow
  // must never restore held state over fresh content).
  const promptNav = useRef<{
    items: readonly string[]
    index: number
    stash: string
    expected: string
  } | null>(null)
  // killYank holds the last kill's restore point and the value that kill
  // wrote: Ctrl+Y restores and consumes it, any other edit drops it,
  // editor.go's one-level undo rule.
  const killYank = useRef<KillSnapshot | null>(null)
  useLayoutEffect(() => {
    valueRef.current = value
    if (promptNav.current !== null && value !== promptNav.current.expected) promptNav.current = null
    if (killYank.current !== null && value !== killYank.current.expected) killYank.current = null
  })
  // typedSinceSend flags edits made while a submit is on the wire: an
  // acceptance must never clear them (a retype included).
  const typedSinceSend = useRef(false)
  // inFlight holds every unanswered submission's trimmed line, one set per
  // verb: an impatient press cannot fire the same submission twice before its
  // reply lands, and a send never blocks an identical queue (or vice versa).
  // Lines key it because slash and shell submits mint no pendingId.
  const inFlight = useRef<Record<SubmitVerb, Set<string>>>({
    send: new Set(),
    queue: new Set(),
  })

  // Shell affordances follow the line ajent will see: the trimmed draft,
  // since submit trims. Marker, hint and the Run label track each keystroke
  // and stand down on an empty or escaped draft.
  const line = value.trim()
  const kind = classifyLine(line)
  const excluded = kind === 'shell-excluded'
  const shell = excluded || kind === 'shell'

  const sendPress = useSubmitPress(areaRef, line === '', disabled)

  // While the search is open the textarea IS the query line, the way ajent's
  // TUI swaps the editor over: claimed keydowns feed the machine directly,
  // and everything a keyboard can deliver without a usable keydown (virtual
  // keys, IME composition, autocorrect) lands here as one value change.
  const shown = search !== null ? search.query : value

  // @-path completion: the caret's token drives a debounced files lookup.
  // Tab or an arrow-moved Enter accepts and drops the caret after the token,
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

  // The cap rides the real line box and the visible viewport, both re-read on
  // resize. A phone's visual viewport shrinks under the keyboard and pans while
  // the caret scrolls, so its resize and scroll events re-measure too, and an
  // unreadable line box degrades to fallbackRowPx.
  const [rowPx, setRowPx] = useState(fallbackRowPx)
  const [viewportPx, setViewportPx] = useState(viewportHeight)
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const measure = () => {
      const px = Number.parseFloat(window.getComputedStyle(el).lineHeight)
      if (Number.isFinite(px) && px > 0) setRowPx(px)
      setViewportPx(viewportHeight())
    }
    measure()
    const vv = window.visualViewport
    window.addEventListener('resize', measure)
    vv?.addEventListener('resize', measure)
    vv?.addEventListener('scroll', measure)
    return () => {
      window.removeEventListener('resize', measure)
      vv?.removeEventListener('resize', measure)
      vv?.removeEventListener('scroll', measure)
    }
  }, [])
  const rowCap = Math.min(maxRows, Math.max(minRows, Math.floor((viewportPx * capShare) / rowPx)))

  // Autosize with what the textarea displays, capped at rowCap line boxes. Past
  // the cap the height stays there and the field scrolls inside instead of the
  // transcript yielding, the capped class switching that overflow on. The class
  // rides the deps too, so a classic scrollbar appearing or leaving re-measures
  // under the width the text actually has.
  const [capped, setCapped] = useState(false)
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    const capPx = rowCap * rowPx
    el.style.height = `${Math.min(el.scrollHeight, capPx)}px`
    setCapped(el.scrollHeight > capPx)
  }, [shown, rowPx, rowCap, capped])

  // One lookup per token query, debounced, failures stay quiet.
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

  // submitLine lands one draft line through its verb's endpoint: prompts mint
  // the client pendingId that paints an optimistic row, slash and shell lines
  // commit as-is. The draft stays put until the reply: a refusal keeps its
  // text, acceptance clears it solely when typing has not already reshaped it.
  const submitLine = useCallback(
    async (
      draft: string,
      verb: SubmitVerb,
      optimistic: (line: string, pendingId: string) => void,
      onFailed: (pendingId: string) => void,
      failureText: string,
    ) => {
      const line = draft.trim()
      if (line === '' || disabled) return
      if (inFlight.current[verb].has(line)) return
      // Shell runs and slash commands commit no message entry, so only
      // prompts paint an optimistic row, classification matches ajent's
      // dispatch, so an escaped or pasted `/`-opening prompt still paints.
      const isPrompt = classifyLine(line) === 'prompt'
      const pendingId = isPrompt ? newPendingID() : undefined
      if (pendingId !== undefined) optimistic(line, pendingId)
      inFlight.current[verb].add(line)
      typedSinceSend.current = false
      clearErrors()
      try {
        await submitWire[verb](sessionId, line, pendingId)
      } catch (err) {
        if (pendingId !== undefined) onFailed(pendingId)
        setSubmitError(describeError(err, failureText))
        return // the refused text stays right where it is
      } finally {
        inFlight.current[verb].delete(line)
      }
      if (!typedSinceSend.current && valueRef.current === draft) {
        onChange('')
        setUploads([]) // the sent prompt takes its chips with it
      }
    },
    [disabled, sessionId, onChange, clearErrors],
  )

  // send submits one draft line exactly as typed in the editor.
  const send = useCallback(
    (draft: string) => submitLine(draft, 'send', onSubmit, onSubmitFailed, 'Submit failed.'),
    [submitLine, onSubmit, onSubmitFailed],
  )

  // queue parks one draft line for the session's next idle point: the same
  // optimistic row and draft rules as send, only the endpoint differs.
  const queue = useCallback(
    (draft: string) => submitLine(draft, 'queue', onQueue, onQueueFailed, 'Queue failed.'),
    [submitLine, onQueue, onQueueFailed],
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
    recall.refresh()
    areaRef.current?.focus({ preventScroll: true }) // touch opens from a button; typing starts now
  }

  // closeSearch drops the search without an accept, like Esc with no match:
  // blur and outside presses both land here, the held draft stays untouched.
  const closeSearch = () => setRawSearch(null)

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
          // Enter accepts without sending, the first Esc selects the same way
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
    clearErrors()
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

  // replaceDraftAt lands one deliberate edit (recall fill, kill, yank)
  // through the draft path: the tracked caret and DOM selection park where
  // the edit leaves them once the controlled commit reaches the textarea, and
  // an in-flight submit acceptance must keep the edit.
  const replaceDraftAt = (next: EditState): void => {
    pendingSelectionRef.current = { text: next.value, caret: next.selectionStart }
    setCaret(next.selectionStart)
    typedSinceSend.current = true
    clearErrors()
    onChange(next.value)
  }

  // replaceDraft applies one recall fill: the caret parks at the end like
  // every programmatic fill.
  const replaceDraft = (text: string) => {
    replaceDraftAt({ value: text, selectionStart: text.length, selectionEnd: text.length })
  }

  // applyKillKey runs one TUI kill/yank chord over the live textarea, the
  // math stays pure (editKeys.ts). An empty kill touches nothing so an older
  // snapshot stays held, a restore consumes its snapshot, and the layout
  // effect above drops it on any other edit.
  const applyKillKey = (key: 'k' | 'u' | 'y', el: HTMLTextAreaElement): void => {
    const value = valueRef.current
    const state: EditState = {
      value,
      selectionStart: el.selectionStart ?? value.length,
      selectionEnd: el.selectionEnd ?? value.length,
    }
    if (key !== 'y') {
      const killed = key === 'k' ? killLineEnd(state) : killLineStart(state)
      if (killed === undefined) return
      killYank.current = killed.snapshot
      replaceDraftAt(killed.next)
      return
    }
    const restored = yank(killYank.current)
    if (restored === undefined) return
    killYank.current = null // the restore consumes the snapshot
    replaceDraftAt(restored)
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
      clearErrors()
      onChange(next)
      return next
    },
    [token, value, caret, onChange, clearErrors, setCaret],
  )

  // acceptCommand splices the chosen command over the slash query, the
  // trailing space ends the token since most commands take an argument, and
  // the next Enter submits. Returns the draft it produced so a moved Enter
  // can send it in one press.
  const acceptCommand = (cmd: CommandDoc): string => {
    if (slash === null) return value
    const insert = `/${cmd.name} `
    const next = `${insert}${value.slice(caret)}`
    pendingSelectionRef.current = { text: next, caret: insert.length }
    setCaret(insert.length)
    // a following Enter submits instead of completing again
    setPick({ key: '', index: 0, moved: false })
    clearErrors()
    onChange(next)
    return next
  }

  // A fresh tap focuses before the browser's default action so WebKit's
  // keyboard reveal scroll never runs: it fights the inset lift and can land
  // the view at the page top (preventScroll is iOS 15.5+). A focused
  // composer keeps native caret placement.
  const focusFreshTap = (ev: PointerEvent<HTMLTextAreaElement>) => {
    if (ev.button !== 0) return
    if (document.activeElement !== ev.currentTarget) ev.currentTarget.focus({ preventScroll: true })
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
    // browsers), while open the same press steps to older matches, the
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
      // an IME mid-composition keeps its keys: candidates and cancel ride them
      if (ev.nativeEvent.isComposing) return
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
          // working without modifiers, on desktop a moved selection completes
          // first, then sends, and an un-moved one falls through to send as
          // typed (the TUI overlay's key rules).
          if (!ev.shiftKey) {
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
    // Ctrl/Cmd+J mirrors Shift+Enter's newline because Chrome, Firefox and
    // Safari deliver the press to the page. Ctrl+Shift+J (DevTools) and AltGr
    // stay with the browser, a completion menu and an IME mid-composition keep
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
      clearErrors()
      onChange(next)
      return
    }
    // Ctrl+K / Ctrl+U / Ctrl+Y carry the TUI's kill/yank into the composer
    // (literal Ctrl only, so Meta stays with the browser and AltGr passes
    // through). The completion menus and the history search keep their keys,
    // and an IME mid-composition is left alone. The chord is claimed even
    // when a kill removes nothing: Ctrl+K and Ctrl+U are browser chords
    // (address bar search, view source) that must not fire from the prompt.
    if (
      search === null &&
      menuKey === '' &&
      ev.ctrlKey &&
      !ev.metaKey &&
      !ev.altKey &&
      !ev.shiftKey &&
      !ev.nativeEvent.isComposing
    ) {
      const killKey = ev.key.toLowerCase()
      if (killKey === 'k' || killKey === 'u' || killKey === 'y') {
        ev.preventDefault()
        applyKillKey(killKey, ev.currentTarget)
        return
      }
    }
    // Plain arrows browse the recall list, an episode always arming from its
    // newest entry, including right after a search accept. Cursor-first like
    // ajent: on the first visual row Up moves the caret to the prompt's start
    // and only a press already on the very first character recalls older, Down
    // mirrors this at the end. A recalled multi-line prompt is editable text,
    // so its caret must reach an edge before the next step, and any edit
    // landing a different draft disarms the browse.
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
  // without a round trip, oversize or unreadable ones fall back to uploading.
  // Up to attachConcurrency files ride the wire at once, each chip tracking its
  // own state, and the batch appends its landed references to the live draft
  // (valueRef.current, not the selection-time value), so typing and prefills
  // during an upload survive. A partial failure keeps the references that
  // landed and names the files that did not. Pasted image files join here too,
  // so paste, picker and drop share one upload path.
  const attach = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0 || disabled || attachingRef.current) return
      const jobs = Array.from(files, (file) => ({ file, id: newID('u') }))
      attachingRef.current = true
      removedUploads.current.clear()
      setAttaching(true)
      setAttachError('')
      setUploads(jobs.map(({ file, id }) => ({ id, name: file.name, status: 'pending' })))
      try {
        const outcomes = await mapLimit(
          jobs,
          attachConcurrency,
          async ({ file, id }): Promise<UploadOutcome> => {
            if (removedUploads.current.has(id)) return { name: file.name }
            setUpload(id, 'uploading')
            try {
              const inlined =
                isTextFile(file) && file.size <= inlineFileCapBytes ? await readInline(file) : null
              if (inlined !== null) {
                setUpload(id, 'done')
                return { name: file.name, reference: inlined }
              }
              const res = await sessionAPI.attach(sessionId, file)
              const reference = `@${res.path}`
              setUpload(id, 'done', reference)
              return { name: file.name, reference }
            } catch (err) {
              setUpload(id, 'failed')
              return { name: file.name, error: describeError(err, 'Attach failed.') }
            }
          },
        )
        const refs = outcomes.flatMap((outcome) =>
          'reference' in outcome ? [outcome.reference] : [],
        )
        const failed = outcomes.filter((outcome) => 'error' in outcome)
        if (refs.length > 0) {
          const draft = valueRef.current
          onChange(draft === '' ? refs.join('\n\n') : `${draft}\n\n${refs.join('\n\n')}`)
        }
        if (failed.length > 0) {
          // one refusal carries its reason, several name their files and
          // stay one readable line
          const names = failed.map((item) => item.name).join(', ')
          setAttachError(
            failed.length === 1
              ? `Could not attach ${names}: ${failed[0]!.error}`
              : `Could not attach ${names}.`,
          )
        }
      } finally {
        attachingRef.current = false
        setAttaching(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [disabled, sessionId, onChange, setUpload],
  )

  // removeUpload drops a queued chip before its turn. An in-flight upload keeps
  // running because the endpoint takes no abort signal, and a landed reference
  // is draft text now, so both stay read-only.
  const removeUpload = (id: string) => {
    removedUploads.current.add(id)
    setUploads((prev) => prev.filter((item) => item.id !== id))
  }

  // File drops ride the picker's attach path. Only a payload carrying files
  // claims a drop: a session drag keeps the chain strip's, a text drag keeps
  // the textarea's own insertion. A file drop is always cancelled whatever the
  // composer's state, or the browser would open the file in the tab, and only
  // attaches while dropReady holds.
  const { dragging } = useSessionDrag()
  // dragDepth counts enter and leave pairs, so moving over a child element
  // never flickers the drop target off
  const [dragDepth, setDragDepth] = useState(0)
  const dropReady = !disabled && !attaching && dragging === null && search === null
  const fileDragging = dragDepth > 0 && dropReady

  const onDragEnter = (ev: DragEvent<HTMLFormElement>) => {
    if (carriesFiles(ev)) setDragDepth((depth) => depth + 1)
  }

  const onDragOver = (ev: DragEvent<HTMLFormElement>) => {
    if (!carriesFiles(ev)) return
    ev.preventDefault() // an uncancelled dragover never delivers the drop
    ev.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (ev: DragEvent<HTMLFormElement>) => {
    if (carriesFiles(ev)) setDragDepth((depth) => Math.max(0, depth - 1))
  }

  const onDrop = (ev: DragEvent<HTMLFormElement>) => {
    if (!carriesFiles(ev)) return
    ev.preventDefault()
    setDragDepth(0)
    if (dropReady) void attach(ev.dataTransfer.files)
  }

  return (
    <form
      className={fileDragging ? 'composer file-drag' : 'composer'}
      onSubmit={onFormSubmit}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* the no-modifier chain path: dropping another session's tab here
          opens the chain dialog with this session as the child */}
      {chainInto !== undefined && <ChainDropStrip sessionId={sessionId} chainInto={chainInto} />}
      {submitError !== '' && (
        <p className="error-text" id={submitErrorId} role="alert">
          {submitError}
        </p>
      )}
      {attachError !== '' && (
        <p className="error-text" id={attachErrorId} role="alert">
          {attachError}
        </p>
      )}
      {uploads.length > 0 && (
        <ul className="composer-uploads" aria-label="Attachments">
          {uploads.map((item) => (
            <li key={item.id} className={`composer-upload ${item.status}`}>
              {/* the working glyph and the landed marks are decoration, the
                  status word beside them carries the state */}
              <span className="composer-upload-icon" aria-hidden="true">
                {item.status === 'uploading' ? (
                  <Spinner state="wait" />
                ) : item.status === 'done' ? (
                  <CheckIcon size={14} />
                ) : item.status === 'failed' ? (
                  <CircleXIcon size={14} />
                ) : null}
              </span>
              <span className="composer-upload-name" title={item.reference}>
                {item.name}
              </span>
              <span className="composer-upload-word">{uploadWords[item.status]}</span>
              {item.status === 'pending' && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => removeUpload(item.id)}
                  aria-label={`Remove ${item.name}`}
                  title="Remove"
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-box" ref={boxRef}>
        {/* popups portal through MenuPopover: pane clipping cannot cut them
            off and the layer stands workspace keys down while visible; an
            outside press dismisses like Escape, and closing never drags focus
            back to a blurred composer */}
        {atOpen && (
          <MenuPopover
            anchorRef={boxRef}
            matchWidth
            restoreFocus={false}
            className="composer-pop"
            onClose={() => setDismissed(tokenKey)}
          >
            <ul className="at-menu" role="listbox" aria-label="Path suggestions">
              {/* one activation path per row: the prevented pointerdown keeps
                  the textarea's caret, click accepts exactly once for touch
                  and mouse, and the keyboard stays owned by the textarea's
                  key rules */}
              {items.map((item, i) => (
                <li key={item.path}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    className={i === highlight ? 'active' : ''}
                    onPointerDown={(ev) => ev.preventDefault()}
                    onClick={() => accept(item)}
                    onMouseEnter={() => setPick({ key: tokenKey, index: i, moved: true })}
                  >
                    {item.path}
                  </button>
                </li>
              ))}
            </ul>
          </MenuPopover>
        )}
        {commandOpen && (
          <MenuPopover
            anchorRef={boxRef}
            matchWidth
            restoreFocus={false}
            className="composer-pop"
            onClose={() => setDismissed(slashKey)}
          >
            <ul className="at-menu slash-menu" role="listbox" aria-label="Commands">
              {commands.map((cmd, i) => (
                <li key={cmd.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    className={i === highlight ? 'active' : ''}
                    ref={i === highlight ? activeCommandRef : undefined}
                    onPointerDown={(ev) => ev.preventDefault()}
                    onClick={() => acceptCommand(cmd)}
                    onMouseEnter={() => setPick({ key: slashKey, index: i, moved: true })}
                  >
                    <span className="slash-name">/{cmd.name}</span>
                    <span className="slash-desc">{cmd.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </MenuPopover>
        )}
        {search !== null && (
          // rows keep the caret through prevented pointerdown, so blur only
          // fires when focus truly left the composer
          <MenuPopover
            anchorRef={boxRef}
            matchWidth
            restoreFocus={false}
            className="composer-pop"
            onClose={closeSearch}
          >
            <HistorySearchOverlay
              search={search}
              onHighlight={(delta) => applySearchKey({ type: 'highlight', delta })}
              onAccept={(text) => acceptSearchMatch(text, search.query)}
              onClose={() => applySearchKey({ type: 'close' })}
            />
          </MenuPopover>
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
          className={capped ? 'capped' : undefined}
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
          aria-invalid={submitError !== '' ? true : undefined}
          aria-describedby={submitError !== '' ? submitErrorId : undefined}
          disabled={disabled}
          onChange={(ev) => {
            if (search !== null) {
              applySearchKey({ type: 'replace', query: ev.target.value })
              return // the draft never changes while the search holds the keys
            }
            typedSinceSend.current = true
            clearErrors()
            onChange(ev.target.value)
          }}
          onPaste={(ev) => {
            // a paste joins the query, never the draft, while the search is
            // open, its images are ignored rather than uploaded into a query
            if (search !== null) {
              ev.preventDefault()
              applySearchKey({ type: 'input', text: ev.clipboardData.getData('text') })
              return
            }
            // pasted screenshots upload through the picker's path, anything
            // else keeps default handling, so plain-text and mixed clipboards
            // still paste as text
            const images = pasteImageFiles(ev.clipboardData)
            if (images === null) return
            ev.preventDefault()
            void attach(images)
          }}
          onKeyDown={onKeyDown}
          onBlur={closeSearch} // focus out without an accept tears the search down
          onPointerDown={focusFreshTap}
          onSelect={(ev) => setCaret(ev.currentTarget.selectionStart ?? 0)}
        />
        {/* attach and send ride beside the prompt, Queue parks a draft
            below them spanning the toolbar */}
        <div className="composer-side">
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
                className="icon-btn"
                disabled={disabled}
                onClick={openSearchOverlay}
                aria-label="Search prompt history"
                title="Search prompt history"
              >
                <SearchIcon />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              disabled={disabled || attaching}
              onClick={() => fileRef.current?.click()}
              aria-label="Attach files"
              title="Attach images or text files"
            >
              {attaching ? '…' : <AttachIcon />}
            </button>
            {/* stop rides beside Send, ahead of it in the touch order */}
            {stop && (
              <button type="button" onClick={stop.onClick} disabled={stop.busy}>
                {stop.busy ? 'Stopping…' : 'Stop'}
              </button>
            )}
            <button
              className={sendPress.keyboardDismiss ? 'primary keyboard-dismiss' : 'primary'}
              type="submit"
              disabled={sendPress.disabled}
              {...sendPress.handlers}
            >
              {shell ? 'Run' : 'Send'}
            </button>
          </div>
          {/* Queue parks the draft for the session's next idle point */}
          <button
            className="composer-queue"
            type="button"
            disabled={sendPress.disabled}
            onClick={() => void queue(value)}
            aria-label="Queue prompt for the next idle point"
            title="Send once this session's provider has been idle for 1 minute"
          >
            Queue
          </button>
        </div>
      </div>
    </form>
  )
}

// newID mints a client-side id: randomUUID where the secure context allows
// it, else a prefixed random hex correlation, since plain HTTP over a LAN IP,
// a supported deployment, lacks the secure-context API.
function newID(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${prefix}${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

// newPendingID mints the correlation pairing an optimistic row with its reply.
const newPendingID = (): string => newID('p')

// mapLimit runs fn over items with at most limit in flight, answering in input
// order.
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++
      results[at] = await fn(items[at]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// carriesFiles reports whether a drag payload holds files: session drags and
// text selections ride other types and keep their default handling.
function carriesFiles(ev: DragEvent): boolean {
  return Array.from(ev.dataTransfer.types).includes('Files')
}

// readInline renders one small text file as a fenced block with the filename
// prefixed above, answering null for binary-looking bytes so the caller
// uploads them instead of landing garbage in the draft.
async function readInline(file: File): Promise<string | null> {
  const text = await file.text()
  if (text.includes('\u0000')) return null
  return `\`${file.name}\`:\n\`\`\`\n${text.replace(/\n$/, '')}\n\`\`\``
}

// ChainDropStrip renders the composer's chain drop target while another
// session's drag is live, the no-modifier discovery path for chaining. A drop
// or an Enter opens the dialog with the dragged session queued after this one.
function ChainDropStrip({
  sessionId,
  chainInto,
}: {
  sessionId: string
  chainInto: NonNullable<ComposerProps['chainInto']>
}) {
  const { dragging } = useSessionDrag()
  if (dragging === null || dragging === sessionId) return null
  const open = () => {
    chainInto.open(dragging)
    sessionDrag.end()
  }
  return (
    <div
      className="composer-chain-strip"
      role="button"
      tabIndex={0}
      aria-label={`Drop to chain ${chainInto.nameFor(dragging)} after ${chainInto.nameFor(sessionId)}`}
      onDragOver={(ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        ev.dataTransfer.dropEffect = 'link'
      }}
      onDrop={(ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        open()
      }}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          open()
        }
      }}
    >
      Drop to chain <strong>{chainInto.nameFor(dragging)}</strong> after this session
    </div>
  )
}
