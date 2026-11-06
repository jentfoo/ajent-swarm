import { useMemo } from 'react'
import { createTwoFilesPatch, diffLines } from 'diff'

import type { EditOp } from './editInput'

// DiffCard renders one file change client-side: the wire carries only
// {path, before, after} strings, never unified patch text, so jsdiff builds
// the hunks here.
export function DiffCard({ path, before, after }: { path: string; before: string; after: string }) {
  const lines = useMemo(() => fileDiffLines(path, before, after), [path, before, after])
  if (lines.length === 0) return null

  return (
    <div className="diff-card" data-testid="diff-card">
      <div className="diff-path mono">{path}</div>
      <DiffRows lines={lines} />
    </div>
  )
}

// EditOpDiff renders one edit op as a fragment diff: oldText is the region the
// model asked to replace, newText the replacement it asked for there.
export function EditOpDiff({ op }: { op: EditOp }) {
  const lines = useMemo(() => opDiffLines(op), [op])
  if (lines.length === 0) return null
  return <DiffRows lines={lines} />
}

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta'
  text: string
}

// DiffRows paints one diff's rows; an empty row keeps its height with a space
function DiffRows({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="mono diff-pre">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line ${line.kind}`}>
          {line.text === '' ? ' ' : line.text}
        </div>
      ))}
    </pre>
  )
}

function fileDiffLines(path: string, before: string, after: string): DiffLine[] {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after)
  const rows = patch.split('\n')
  // Rows before the first @@ are jsdiff's banner and file headers, which carry
  // nothing the path chip above does not. Filtering marker prefixes past that
  // point would drop body rows like a deleted "---" frontmatter fence, so
  // hunks render whole with their @@ line as a meta row.
  const hunkStart = rows.findIndex((row) => row.startsWith('@@'))
  if (hunkStart < 0) return [] // unchanged file: headers only
  return rows.slice(hunkStart).map<DiffLine>((row) => {
    if (row.startsWith('@@')) return { kind: 'meta', text: row }
    if (row.startsWith('+')) return { kind: 'add', text: row.slice(1) }
    if (row.startsWith('-')) return { kind: 'del', text: row.slice(1) }
    return { kind: 'ctx', text: row.startsWith(' ') ? row.slice(1) : row }
  })
}

// opDiffLines builds one op's fragment diff. Hunk headers would number
// fragment lines rather than file lines, so they are dropped; a replace_all op
// leads with a meta row so its breadth stays visible.
function opDiffLines(op: EditOp): DiffLine[] {
  if (op.oldText === op.newText) return []
  const lines: DiffLine[] = op.replaceAll
    ? [{ kind: 'meta', text: 'replace every occurrence' }]
    : []
  for (const run of diffLines(op.oldText, op.newText)) {
    const kind: DiffLine['kind'] = run.added ? 'add' : run.removed ? 'del' : 'ctx'
    for (const text of splitRows(run.value)) lines.push({ kind, text })
  }
  return lines
}

// splitRows breaks text into display rows; a trailing newline ends the final
// row rather than opening a new empty one
export function splitRows(value: string): string[] {
  const rows = value.split('\n')
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
  return rows
}
