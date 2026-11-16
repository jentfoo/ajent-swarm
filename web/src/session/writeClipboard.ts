// writeClipboard writes text to the system clipboard for a user-initiated
// copy. The async Clipboard API is tried first, and a hidden-textarea
// execCommand fallback covers engines that reject it (Firefox focus and
// activation checks) plus plain-HTTP origins where navigator.clipboard does
// not exist at all.
export function writeClipboard(text: string): Promise<void> {
  const api = navigator.clipboard
  if (api?.writeText !== undefined) {
    return api.writeText(text).catch(() => {
      // the click's transient activation still holds here, so execCommand can
      // land where writeText refused
      if (!execCopy(text)) throw new Error('clipboard copy rejected')
    })
  }
  return execCopy(text) ? Promise.resolve() : Promise.reject(new Error('no clipboard available'))
}

// execCopy selects the text in an offscreen textarea and copies the selection,
// restoring whatever the user had highlighted first, then hands focus back to
// the element that held it.
function execCopy(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false
  const selection = window.getSelection()
  const restore = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  // saved before ta.focus() takes it, removal later drops focus to <body>
  const active = document.activeElement

  const ta = document.createElement('textarea')
  ta.value = text
  // rendered but offscreen, fixed so focus never scrolls the page to reach it
  // readonly keeps mobile keyboards closed
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-9999px'
  document.body.appendChild(ta)

  let ok: boolean
  try {
    ta.focus()
    ta.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()

  // puts typing back where it was, skipping anything a copy event handler
  // already detached. preventScroll since restoring focus never moves the page
  if (active instanceof HTMLElement && active.isConnected) {
    active.focus({ preventScroll: true })
  }

  if (restore !== null && selection !== null) {
    selection.removeAllRanges()
    selection.addRange(restore)
  }
  return ok === true
}
