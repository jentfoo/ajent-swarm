// Clipboard image extraction for the composer's paste handler: a pasted
// screenshot rides the file picker's attach path exactly as if it had been
// picked, mirroring ajent's TUI Ctrl+V token. Plain text in the same paste
// always wins, because some apps ship a rendered thumbnail alongside
// formatted text.

// PasteData is the slice of ClipboardEvent.clipboardData the decision reads,
// structural so tests build plain objects instead of a real DataTransfer.
export interface PasteData {
  getData(format: string): string
  readonly files: ArrayLike<File>
}

// pasteImageFiles returns the clipboard's image files when they should win
// (images present, no usable plain-text variant beside them), else null for
// default handling. Non-image files never join: text-file inlining stays
// picker-only.
export function pasteImageFiles(data: PasteData): File[] | null {
  // whitespace is padding some editors ship under an image, the image wins
  if (data.getData('text').trim() !== '') return null
  const images = Array.from(data.files).filter((file) => file.type.startsWith('image/'))
  return images.length > 0 ? images : null
}
