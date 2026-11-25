import { describe, expect, it } from 'vitest'

// The manifest the service serves verbatim from web/public: a stable id keeps
// one app identity across reinstalls and shortcuts deep-link the two
// phone-first actions. Node's fs reads the file like theme.test.ts reads the
// stylesheet; the web tsconfig types only the DOM, hence the probe below.
// @ts-expect-error node builtins stay untyped in the web project on purpose
const fs = (await import('node:fs')) as {
  readFileSync(path: string, encoding: string): string
}
type ShortcutIcon = { src?: string }
type Shortcut = { name?: string; url?: string; icons?: ShortcutIcon[] }
const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8')) as {
  id?: string
  lang?: string
  shortcuts?: Shortcut[]
}

describe('web manifest', () => {
  it('pins a stable id and language', () => {
    expect(manifest.id).toBe('/')
    expect(manifest.lang).toBe('en')
  })

  it('shortcuts to new session and jobs with the small icon', () => {
    const shortcuts = manifest.shortcuts ?? []
    expect(shortcuts.map((s) => [s.name, s.url])).toEqual([
      ['New session', '/?new=1'],
      ['Jobs', '/jobs'],
    ])
    // platform launchers render shortcuts from an icon of their own
    for (const shortcut of shortcuts) {
      expect(
        (shortcut.icons ?? []).some((icon: ShortcutIcon) => icon.src === '/icon-192.png'),
      ).toBe(true)
    }
  })
})
