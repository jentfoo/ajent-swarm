import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { diffChars, diffLines, structuredPatch } from 'diff'
import type { StructuredPatchHunk } from 'diff'

import type { EditOp } from './editInput'

// context lines kept around each change, matching git's default. Enough to
// place a change without reprinting the file around it.
const contextLines = 3
// narrowest the line number column gets
const minGutter = 2
// fraction of a paired line that must stay unchanged before intraline emphasis
// is worth showing instead of a whole line replacement
const minIntralineSimilarity = 0.5
// edits closer together than this many unchanged characters are joined, to
// avoid speckled highlights
const minSpanGap = 4

// DiffCard renders one file change client-side: the wire carries only
// {path, before, after} strings, never unified patch text, so jsdiff builds
// the hunks here.
export function DiffCard({ path, before, after }: { path: string; before: string; after: string }) {
  const view = useMemo(() => fileDiffRows(before, after), [before, after])
  if (view.rows.length === 0) return null

  return (
    <div className="diff-card" data-testid="diff-card">
      <div className="diff-path mono">{path}</div>
      <DiffRows view={view} />
    </div>
  )
}

// EditOpDiff renders one edit op as a fragment diff: oldText is the region the
// model asked to replace, newText the replacement it asked for there.
export function EditOpDiff({ op }: { op: EditOp }) {
  const view = useMemo(() => opDiffRows(op), [op])
  if (view.rows.length === 0) return null
  return <DiffRows view={view} />
}

export type DiffKind = 'add' | 'del' | 'ctx' | 'meta'

// one rendered row: kind carries the screen role, num the file line it came
// from (null on hunk headers), em the intraline changed ranges within text
interface DiffRow {
  kind: DiffKind
  num: number | null
  text: string
  em?: Array<[number, number]>
}

// one diff's rows plus the gutter width they pad against
interface DiffLayout {
  gw: number
  rows: DiffRow[]
}

// DiffRows paints one diff's rows: a right-aligned line number and marker
// gutter, then the content. Color and marker carry meaning, never background.
function DiffRows({ view }: { view: DiffLayout }) {
  return (
    <pre className="mono diff-pre">
      {view.rows.map((row, i) => (
        <div key={i} className={`diff-line ${row.kind}`}>
          {row.num !== null && (
            <>
              <span className="diff-num">{String(row.num).padStart(view.gw)}</span>
              <span className="diff-mark">
                {row.kind === 'del' ? '- ' : row.kind === 'add' ? '+ ' : '  '}
              </span>
            </>
          )}
          <DiffText text={row.text} em={row.em} />
        </div>
      ))}
    </pre>
  )
}

// DiffText paints one row's content; an empty row keeps its height with a
// space, and the intraline changed ranges render emphasized
function DiffText({ text, em }: { text: string; em?: Array<[number, number]> }) {
  const shown = text === '' ? ' ' : text
  if (em === undefined || em.length === 0) return <span className="diff-text">{shown}</span>
  const parts: ReactNode[] = []
  let pos = 0
  for (const [start, end] of em) {
    if (start >= shown.length) break
    if (start > pos) parts.push(shown.slice(pos, start))
    const stop = Math.min(end, shown.length)
    parts.push(
      <span key={parts.length} className="diff-em">
        {shown.slice(start, stop)}
      </span>,
    )
    pos = stop
  }
  if (pos < shown.length) parts.push(shown.slice(pos))
  return <span className="diff-text">{parts}</span>
}

// fileDiffRows builds a whole-file diff: one hunk per changed region under its
// own @@ header, numbered by the file each line came from. Empty when before
// and after match.
function fileDiffRows(before: string, after: string): DiffLayout {
  const patch = structuredPatch('', '', before, after, '', '', { context: contextLines })
  const rows: DiffRow[] = []
  for (const hunk of patch.hunks) {
    rows.push(metaRow(hunkHeaderText(hunk)))
    rows.push(...hunkRows(hunk.lines, hunk.oldStart, hunk.newStart))
  }
  return { gw: gutterWidth(before, after), rows }
}

// opDiffRows builds one op's fragment diff, numbered within the fragment: the
// wire never says where oldText sat in the file. Hunk headers would number
// fragment lines rather than file lines, so none render; a replace_all op
// leads with a meta row so its breadth stays visible.
function opDiffRows(op: EditOp): DiffLayout {
  if (op.oldText === op.newText) return { gw: minGutter, rows: [] }
  const lines: string[] = []
  for (const run of diffLines(op.oldText, op.newText)) {
    const mark = run.added ? '+' : run.removed ? '-' : ' '
    for (const text of splitRows(run.value)) lines.push(mark + text)
  }
  const rows = op.replaceAll ? [metaRow('replace every occurrence')] : []
  return { gw: gutterWidth(op.oldText, op.newText), rows: [...rows, ...hunkRows(lines, 1, 1)] }
}

function metaRow(text: string): DiffRow {
  return { kind: 'meta', num: null, text }
}

// hunkRows walks marked patch rows (' ', '-', '+'), numbering each line by the
// file it came from and pairing adjacent deletion/addition runs for intraline
// emphasis. '\' no-newline markers carry no content and drop.
function hunkRows(lines: string[], oldStart: number, newStart: number): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = oldStart
  let newNo = newStart
  let dels: DiffRow[] = []
  let adds: DiffRow[] = []
  const flush = () => {
    rows.push(...runRows(dels, adds))
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.startsWith('\\')) continue
    const text = line.slice(1)
    if (line.startsWith('-')) dels.push({ kind: 'del', num: oldNo++, text })
    else if (line.startsWith('+')) adds.push({ kind: 'add', num: newNo++, text })
    else {
      flush()
      rows.push({ kind: 'ctx', num: newNo++, text })
      oldNo++
    }
  }
  flush()
  return rows
}

// runRows lays out one deletion/addition run, deletions first; equal-length
// runs pair line by line so each pair can carry intraline emphasis
function runRows(dels: DiffRow[], adds: DiffRow[]): DiffRow[] {
  if (dels.length > 0 && dels.length === adds.length) {
    for (let i = 0; i < dels.length; i++) {
      const spans = intralineSpans(dels[i].text, adds[i].text)
      if (spans !== undefined) {
        dels[i].em = spans.del
        adds[i].em = spans.add
      }
    }
  }
  return [...dels, ...adds]
}

// hunkHeaderText renders the @@ range marker, following git in dropping the
// count when a side spans one line; an empty side starts at 0
function hunkHeaderText(hunk: StructuredPatchHunk): string {
  return `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`
}

function hunkRange(start: number, count: number): string {
  if (count === 0) return '0,0'
  if (count === 1) return String(start)
  return `${start},${count}`
}

// gutterWidth sizes the line number column once per diff from the whole file,
// so numbers stay right-aligned across hunks instead of jumping
export function gutterWidth(before: string, after: string): number {
  const lines = Math.max(splitRows(before).length, splitRows(after).length)
  return Math.max(minGutter, String(lines).length)
}

export interface IntralineSpans {
  del: Array<[number, number]>
  add: Array<[number, number]>
}

interface CharEdit {
  delStart: number
  delEnd: number
  addStart: number
  addEnd: number
}

// intralineSpans returns the changed ranges within each side of one paired
// line, undefined when the lines are too dissimilar for emphasis to help
export function intralineSpans(before: string, after: string): IntralineSpans | undefined {
  const edits = mergeCloseEdits(charEdits(before, after))
  if (edits.length === 0) return undefined
  const spans: IntralineSpans = { del: [], add: [] }
  let changed = 0
  for (const e of edits) {
    if (e.delEnd > e.delStart) {
      spans.del.push([e.delStart, e.delEnd])
      changed += e.delEnd - e.delStart
    }
    if (e.addEnd > e.addStart) {
      spans.add.push([e.addStart, e.addEnd])
      changed += e.addEnd - e.addStart
    }
  }
  // gate on post-merge coverage: a joined gap highlights unchanged text too,
  // so pre-merge counts would let a chain of tiny edits pass as a minor tweak
  const total = before.length + after.length
  if (total === 0 || (total - changed) / total < minIntralineSimilarity) return undefined
  return spans
}

// charEdits groups the character diff into replacement regions: consecutive
// removed and added parts form one edit covering both sides
function charEdits(before: string, after: string): CharEdit[] {
  const edits: CharEdit[] = []
  let oldPos = 0
  let newPos = 0
  let cur: CharEdit | undefined
  for (const part of diffChars(before, after)) {
    if (part.value === '') continue
    if (part.added === true) {
      cur ??= { delStart: oldPos, delEnd: oldPos, addStart: newPos, addEnd: newPos }
      cur.addEnd += part.value.length
      newPos += part.value.length
    } else if (part.removed === true) {
      cur ??= { delStart: oldPos, delEnd: oldPos, addStart: newPos, addEnd: newPos }
      cur.delEnd += part.value.length
      oldPos += part.value.length
    } else {
      oldPos += part.value.length
      newPos += part.value.length
      if (cur !== undefined) {
        edits.push(cur)
        cur = undefined
      }
    }
  }
  if (cur !== undefined) edits.push(cur)
  return edits
}

// mergeCloseEdits joins edits separated by fewer than minSpanGap unchanged
// characters. The gap is absorbed on both sides at once: joining spans per
// side instead would highlight text the other side still shows as unchanged.
function mergeCloseEdits(edits: CharEdit[]): CharEdit[] {
  const out: CharEdit[] = []
  for (const e of edits) {
    const prev = out[out.length - 1]
    // two bare insertions stay apart, there is no old-side gap to absorb
    if (
      prev !== undefined &&
      e.delStart - prev.delEnd < minSpanGap &&
      (prev.delStart !== prev.delEnd || e.delStart !== e.delEnd)
    ) {
      prev.delEnd = e.delEnd
      prev.addEnd = e.addEnd
      continue
    }
    out.push(e)
  }
  return out
}

// splitRows breaks text into display rows; a trailing newline ends the final
// row rather than opening a new empty one
export function splitRows(value: string): string[] {
  const rows = value.split('\n')
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
  return rows
}
