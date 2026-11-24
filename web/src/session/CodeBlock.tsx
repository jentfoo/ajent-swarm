import { Fragment, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { codeToTokens } from 'shiki'
import type { BundledLanguage, ThemedToken } from 'shiki'

import { CopyButton } from './CopyButton'

// TextMate font-style bits the theme data carries on each token.
const fontStyleItalic = 1
const fontStyleBold = 2
const fontStyleUnderline = 4
const fontStyleStrikethrough = 8

// CodeBlock highlights one fence through shiki's singleton highlighter, which
// loads each language's bundle lazily on first use. Tokens render as React
// elements instead of generated HTML, so model-authored text is always a
// framework-escaped child and no raw markup crosses this boundary. Unknown
// languages and highlight failures fall back to the plain fence rather than
// the raw error.
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [lines, setLines] = useState<ThemedToken[][] | null>(null)

  useEffect(() => {
    let alive = true
    if (lang === undefined) return // no hint: keep the plain fence
    // The fence language is regex-extracted model text, so any string can
    // arrive; unknown names throw into the catch and keep the plain fence.
    codeToTokens(code, { lang: lang as BundledLanguage, theme: 'github-dark' })
      .then((out) => {
        if (alive) setLines(out.tokens)
      })
      .catch(() => {
        if (alive) setLines(null) // unhighlighted text beats a broken card
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
        {lines ? (
          <code>
            {lines.map((line, i) => (
              <Fragment key={i}>
                {i > 0 && '\n'}
                {line.map((token, j) => (
                  <span key={j} style={tokenStyle(token)}>
                    {token.content}
                  </span>
                ))}
              </Fragment>
            ))}
          </code>
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </div>
  )
}

// tokenStyle narrows the theme's per-token facts to a React style object.
// Themes are bundled, not model-authored, so their values ride as-is.
function tokenStyle(token: ThemedToken): CSSProperties | undefined {
  const style: CSSProperties & Record<string, string> = {}
  if (token.color !== undefined) style.color = token.color
  if (token.bgColor !== undefined) style.backgroundColor = token.bgColor
  const bits = token.fontStyle ?? 0
  if ((bits & fontStyleItalic) !== 0) style.fontStyle = 'italic'
  if ((bits & fontStyleBold) !== 0) style.fontWeight = 'bold'
  const decorations = [
    (bits & fontStyleUnderline) !== 0 ? 'underline' : '',
    (bits & fontStyleStrikethrough) !== 0 ? 'line-through' : '',
  ].filter((d) => d !== '')
  if (decorations.length > 0) style.textDecoration = decorations.join(' ')
  if (token.htmlStyle !== undefined) Object.assign(style, token.htmlStyle)
  return Object.keys(style).length === 0 ? undefined : style
}
