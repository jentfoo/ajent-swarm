import { useMemo } from 'react'
import { createTwoFilesPatch } from 'diff'

// DiffCard renders one file change client-side: the wire carries only
// {path, before, after} strings, never unified patch text, so jsdiff builds
// the hunks here.
export function DiffCard({ path, before, after }: { path: string; before: string; after: string }) {
  const lines = useMemo(() => diffLines(path, before, after), [path, before, after])
  if (lines.length === 0) return null

  return (
    <div className="diff-card" data-testid="diff-card">
      <div className="diff-path mono">{path}</div>
      <pre className="mono">
        {lines.map((line, i) => (
          <div key={i} className={`diff-line ${line.kind}`}>
            {line.text === '' ? ' ' : line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta'
  text: string
}

function diffLines(path: string, before: string, after: string): DiffLine[] {
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
