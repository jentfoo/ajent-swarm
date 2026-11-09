// Terminal kill/yank transforms for the composer, the web transcription of
// ajent's TUI editor keys (pkg/tui/editor.go): Ctrl+K kills from the caret to
// the line's end, Ctrl+U from the line's start to the caret, and Ctrl+Y
// restores the buffer the last kill replaced. The TUI kills respect wrapped
// visual rows because it paints them, a textarea cannot know wrapping without
// measuring, so these operate on logical lines (the caret to the nearest
// newline or value boundary), an accepted difference.

export interface EditState {
  value: string
  selectionStart: number
  selectionEnd: number
}

// KillSnapshot is the one-level restore point a kill leaves: the buffer state
// it replaced and the value the kill wrote, so any later draft change the kill
// keys did not make drops it (editor.go's undo semantics).
export interface KillSnapshot {
  restore: EditState
  expected: string
}

// KillResult is one kill's outcome: the collapsed state it leaves and the
// snapshot restoring what it replaced.
export interface KillResult {
  next: EditState
  snapshot: KillSnapshot
}

// killLineEnd removes from the caret to the end of its logical line, the
// caret staying put so the line below joins at it. A caret sitting on a
// newline removes it like Delete, and a caret on a trailing empty line joins
// the line above. A selection collapses to its start first. undefined means
// nothing was removed, so an older snapshot stays held.
export function killLineEnd(state: EditState): KillResult | undefined {
  const value = state.value
  const caret = state.selectionStart
  const newline = value.indexOf('\n', caret)
  const stop = newline === -1 ? value.length : newline
  if (stop > caret) return killed(state, without(value, caret, stop), caret)
  if (value[caret] === '\n') return killed(state, without(value, caret, caret + 1), caret)
  if (caret === value.length && value[caret - 1] === '\n') {
    // a trailing empty line joins the one above, caret at its start
    const above = value.slice(0, caret - 1).lastIndexOf('\n') + 1
    return killed(state, without(value, caret - 1, caret), above)
  }
  return undefined
}

// killLineStart removes from the start of the caret's logical line to the
// caret, parking the caret at the line's start. A selection collapses to its
// start first. undefined means nothing was removed, so an older snapshot
// stays held.
export function killLineStart(state: EditState): KillResult | undefined {
  const value = state.value
  const caret = state.selectionStart
  const lineStart = value.slice(0, caret).lastIndexOf('\n') + 1
  if (lineStart === caret) return undefined
  return killed(state, without(value, lineStart, caret), lineStart)
}

// yank reads the restore point the last kill left. undefined means nothing
// is held: an earlier yank consumed it or another edit dropped it.
export function yank(snapshot: KillSnapshot | null | undefined): EditState | undefined {
  return snapshot?.restore
}

// killed bundles one kill's outcome with the snapshot of what it replaced.
function killed(state: EditState, value: string, caret: number): KillResult {
  return {
    next: { value, selectionStart: caret, selectionEnd: caret },
    snapshot: { restore: state, expected: value },
  }
}

// without returns value with [start, end) removed.
function without(value: string, start: number, end: number): string {
  return value.slice(0, start) + value.slice(end)
}
