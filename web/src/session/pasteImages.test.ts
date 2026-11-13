import { describe, expect, it } from 'vitest'

import { pasteImageFiles, type PasteData } from './pasteImages'

// pasteOf fakes a ClipboardEvent's clipboardData: getData answers every
// format with text, files lists what the paste carries.
function pasteOf(files: File[], text = ''): PasteData {
  return { getData: () => text, files }
}

describe('pasteImageFiles', () => {
  it('returns image files when no text rides the paste', () => {
    const shot = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    expect(pasteImageFiles(pasteOf([shot]))).toEqual([shot])
  })

  it('keeps order for multi-image pastes', () => {
    const png = new File(['a'], 'one.png', { type: 'image/png' })
    const jpeg = new File(['b'], 'two.jpg', { type: 'image/jpeg' })
    expect(pasteImageFiles(pasteOf([png, jpeg]))).toEqual([png, jpeg])
  })

  it('prefers text when a thumbnail rides along', () => {
    // formatted-text copies often carry a rendered image beside the words
    const shot = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    expect(pasteImageFiles(pasteOf([shot], 'copied note'))).toBeNull()
  })

  it('treats whitespace-only text as no text', () => {
    const shot = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    expect(pasteImageFiles(pasteOf([shot], ' \n\t'))).toEqual([shot])
  })

  it('falls back to default paste for non-image files', () => {
    // text-file inlining stays picker-only, so a file without an image type
    // never uploads from a paste
    const doc = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' })
    expect(pasteImageFiles(pasteOf([doc]))).toBeNull()
  })

  it('treats an untyped file as non-image', () => {
    const mystery = new File(['bytes'], 'blob.bin')
    expect(pasteImageFiles(pasteOf([mystery]))).toBeNull()
  })

  it('uploads only the images from a mixed file paste', () => {
    const txt = new File(['a'], 'notes.txt', { type: 'text/plain' })
    const shot = new File(['png-bytes'], 'shot.png', { type: 'image/png' })
    expect(pasteImageFiles(pasteOf([txt, shot]))).toEqual([shot])
  })

  it('returns null on an empty file list', () => {
    expect(pasteImageFiles(pasteOf([]))).toBeNull()
  })
})
