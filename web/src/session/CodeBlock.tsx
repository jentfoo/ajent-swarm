import { useEffect, useState } from 'react'
import { codeToHtml } from 'shiki'

import { CopyButton } from './CopyButton'

// CodeBlock highlights one fence through shiki's singleton highlighter, which
// loads each language's bundle lazily on first use. Unknown languages and
// highlight failures fall back to the plain fence rather than the raw error.
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    let alive = true
    if (lang === undefined) return // no hint: keep the plain fence
    codeToHtml(code, { lang, theme: 'github-dark' })
      .then((out) => {
        if (alive) setHtml(out)
      })
      .catch(() => {
        if (alive) setHtml('') // unhighlighted text beats a broken card
      })
    return () => {
      alive = false
    }
  }, [code, lang])

  return (
    // the copy overlay rides outside the scrolling pre so horizontal code
    // scroll never carries it away, and both highlight branches share it
    <div className="fence-wrap">
      <CopyButton text={code} className="fence-copy" />
      <pre className="fence" data-lang={lang}>
        {html !== '' ? (
          // shiki output is generated markup with the code escaped inside; no
          // model-authored HTML crosses this boundary
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  )
}
