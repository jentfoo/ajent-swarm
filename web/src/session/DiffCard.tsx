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
  return (
    patch
      .split('\n')
      // the leading "====" banner and file headers carry nothing the path chip
      // above does not; hunks keep their @@ line as a meta row
      .filter(
        (line) => !line.startsWith('===') && !line.startsWith('---') && !line.startsWith('+++'),
      )
      .map<DiffLine>((line) => {
        if (line.startsWith('@@')) return { kind: 'meta', text: line }
        if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) }
        if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) }
        return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line }
      })
  )
}
