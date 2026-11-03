import { docFromHtml, docFromPlainText, validateRichTextDoc } from '../domain/richtext'
import type { RichTextDoc } from '../domain/types'
import { IMAGE_PLACEHOLDER } from './docxConvert'

/** Converted content in reading order: text sections and embedded images (by index). */
export type DocxBlock = { kind: 'text'; doc: RichTextDoc } | { kind: 'image'; index: number }

/** Top-level elements per text box (long documents become several boxes, split at headings). */
const MAX_ELEMENTS_PER_BOX = 40

/**
 * Split converter HTML into text sections and images. The HTML is parsed in an
 * inert document (no scripts run, nothing is fetched) and every section is
 * rebuilt through the note schema, which drops anything it does not know
 * (scripts, styles, frames, event attributes, unsafe links). Images inside a
 * paragraph are placed after it.
 */
export function htmlToBlocks(html: string, maxChars: number): { blocks: DocxBlock[]; truncated: boolean; fallbacks: number } {
  const dom = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
  const blocks: DocxBlock[] = []
  let chunk: string[] = []
  let chars = 0
  let truncated = false
  let fallbacks = 0
  const flush = () => {
    if (chunk.length === 0) return
    const html = chunk.join('')
    chunk = []
    let doc = docFromHtml(html)
    if (validateRichTextDoc(doc) !== null) {
      // Should not happen (the schema built it), but never store an invalid document.
      fallbacks++
      const tmp = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
      doc = docFromPlainText(tmp.body.textContent ?? '')
    }
    blocks.push({ kind: 'text', doc })
  }
  for (const el of Array.from(dom.body.children)) {
    if (chars > maxChars) {
      truncated = true
      break
    }
    const images: number[] = []
    for (const img of Array.from(el.querySelectorAll('img')).concat(el.tagName === 'IMG' ? [el as HTMLImageElement] : [])) {
      const src = img.getAttribute('src') ?? ''
      if (src.startsWith(IMAGE_PLACEHOLDER)) {
        const n = Number(src.slice(IMAGE_PLACEHOLDER.length))
        if (Number.isInteger(n) && n >= 0) images.push(n)
      }
      img.remove()
    }
    const hasContent = el.tagName !== 'IMG' && ((el.textContent ?? '').trim().length > 0 || el.querySelector('table, hr') !== null || el.tagName === 'TABLE' || el.tagName === 'HR')
    if (hasContent) {
      if (/^H[12]$/.test(el.tagName) && chunk.length >= 6) flush()
      chunk.push(el.outerHTML)
      chars += (el.textContent ?? '').length
      if (chunk.length >= MAX_ELEMENTS_PER_BOX) flush()
    }
    if (images.length > 0) {
      flush()
      for (const index of images) blocks.push({ kind: 'image', index })
    }
  }
  flush()
  return { blocks, truncated, fallbacks }
}
