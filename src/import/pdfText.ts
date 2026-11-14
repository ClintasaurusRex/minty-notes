import type { RichTextDoc, RichTextNode } from '../domain/types'

/**
 * Text-based PDF → editable draft (pure). PDF text has no structure, only
 * positioned runs, so this rebuilds lines and paragraphs from positions,
 * marks larger text as headings, and turns bullet lines into lists. Reading
 * order of multi-column layouts and tables is not reconstructed.
 */

/** One positioned text run (PDF units, y grows upwards as in PDF). */
export interface PdfRun {
  str: string
  x: number
  y: number
  /** Font size (height of the run). */
  size: number
  width: number
}

export interface PdfPageText {
  number: number
  runs: PdfRun[]
}

interface Line {
  y: number
  size: number
  text: string
}

// Control characters (other than tab/newline) are junk in note text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const BULLET = /^[•◦▪▫‣∙●○■□–-]\s+/

function clean(s: string): string {
  return s.replace(CONTROL, '').replace(/\u00a0/g, ' ')
}

/** Group runs into lines (same baseline within a tolerance), left to right. */
export function linesOf(runs: PdfRun[]): Line[] {
  const sorted = runs.filter((r) => clean(r.str).length > 0).sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: { y: number; size: number; runs: PdfRun[] }[] = []
  for (const r of sorted) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - r.y) <= Math.max(2, 0.45 * Math.max(r.size, last.size))) {
      last.runs.push(r)
      last.size = Math.max(last.size, r.size)
    } else lines.push({ y: r.y, size: r.size, runs: [r] })
  }
  return lines
    .map((l) => {
      const runs = l.runs.sort((a, b) => a.x - b.x)
      let text = ''
      let end = -Infinity
      for (const r of runs) {
        const s = clean(r.str)
        const gap = r.x - end
        if (text && gap > 0.2 * l.size && !/\s$/.test(text) && !/^\s/.test(s)) text += ' '
        text += s
        end = r.x + r.width
      }
      return { y: l.y, size: l.size, text: text.replace(/\s+/g, ' ').trim() }
    })
    .filter((l) => l.text.length > 0)
}

/** Most common text size (the body size), used to spot headings. */
export function bodySize(pages: PdfPageText[]): number {
  const counts = new Map<number, number>()
  for (const p of pages) for (const r of p.runs) if (r.str.trim()) counts.set(Math.round(r.size), (counts.get(Math.round(r.size)) ?? 0) + r.str.length)
  let best = 12
  let n = -1
  for (const [size, c] of counts) if (c > n) [best, n] = [size, c]
  return best
}

const text = (t: string, marks?: RichTextNode['marks']): RichTextNode => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t })

/**
 * One page's lines → document nodes: paragraphs (wrapped lines joined),
 * headings (noticeably larger, short lines), and bullet lists.
 */
export function pageToNodes(lines: Line[], body: number): RichTextNode[] {
  const nodes: RichTextNode[] = []
  let para: Line[] = []
  let bullets: string[] = []
  const flushPara = () => {
    if (para.length === 0) return
    let joined = ''
    for (const l of para) joined = joined && /[A-Za-z]-$/.test(joined) && /^[a-z]/.test(l.text) ? joined.slice(0, -1) + l.text : joined ? `${joined} ${l.text}` : l.text
    const size = Math.max(...para.map((l) => l.size))
    const level = joined.length <= 140 && size >= body * 1.6 ? 2 : joined.length <= 140 && size >= body * 1.2 ? 3 : 0
    nodes.push(level ? { type: 'heading', attrs: { level }, content: [text(joined)] } : { type: 'paragraph', content: [text(joined)] })
    para = []
  }
  const flushBullets = () => {
    if (bullets.length === 0) return
    nodes.push({ type: 'bulletList', content: bullets.map((b) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [text(b)] }] })) })
    bullets = []
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const prev = lines[i - 1]
    if (BULLET.test(l.text)) {
      flushPara()
      bullets.push(l.text.replace(BULLET, ''))
      continue
    }
    // A wrapped bullet line continues the previous bullet.
    if (bullets.length > 0 && prev && prev.y - l.y <= prev.size * 1.6 && Math.abs(l.size - prev.size) < 1) {
      bullets[bullets.length - 1] += ` ${l.text}`
      continue
    }
    flushBullets()
    const sameParagraph = prev && para.length > 0 && prev.y - l.y <= Math.max(prev.size, l.size) * 1.6 && Math.abs(l.size - prev.size) <= Math.max(1, prev.size * 0.15)
    if (!sameParagraph) flushPara()
    para.push(l)
  }
  flushPara()
  flushBullets()
  return nodes
}

export interface PdfDraft {
  /** One document per converted page (in page order). */
  pages: { number: number; doc: RichTextDoc }[]
  /** Pages with no selectable text (likely scanned images). */
  emptyPages: number[]
  truncated: boolean
}

/** Every page's text → editable documents, each starting with a "Page N" marker. */
export function pdfToDocs(pages: PdfPageText[], maxChars: number): PdfDraft {
  const body = bodySize(pages)
  const out: PdfDraft = { pages: [], emptyPages: [], truncated: false }
  let chars = 0
  for (const p of pages) {
    const lines = linesOf(p.runs)
    if (lines.length === 0) {
      out.emptyPages.push(p.number)
      continue
    }
    if (chars > maxChars) {
      out.truncated = true
      break
    }
    chars += lines.reduce((n, l) => n + l.text.length, 0)
    const marker: RichTextNode = { type: 'paragraph', content: [text(`Page ${p.number}`, [{ type: 'italic' }])] }
    out.pages.push({ number: p.number, doc: { type: 'doc', content: [marker, ...pageToNodes(lines, body)] } })
  }
  return out
}
