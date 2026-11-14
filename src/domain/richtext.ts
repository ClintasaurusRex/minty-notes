import { getSchema, generateJSON, type Extensions } from '@tiptap/core'
import { Node as PMNode, type Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { isPageLinkId, PAGE_LINK, PageLink } from './pageLink'
import type { RichTextDoc, RichTextNode } from './types'

/** Largest column or row span accepted in a table cell (keeps table maps small). */
export const MAX_CELL_SPAN = 50
const MAX_COL_WIDTH = 10_000

function parseSpan(el: HTMLElement, name: 'colspan' | 'rowspan'): number {
  const n = Number.parseInt(el.getAttribute(name) ?? '', 10)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CELL_SPAN) : 1
}

/**
 * Pasted or imported cells get bounded spans, and column widths are not taken
 * over (tables size to their text box), so outside HTML can never store a value
 * that later fails backup validation or makes the table map huge.
 */
const safeCellAttributes = {
  colspan: { default: 1, parseHTML: (el: HTMLElement) => parseSpan(el, 'colspan') },
  rowspan: { default: 1, parseHTML: (el: HTMLElement) => parseSpan(el, 'rowspan') },
  colwidth: { default: null, parseHTML: () => null },
}
const SafeTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...safeCellAttributes }
  },
})
const SafeTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...safeCellAttributes }
  },
})

/**
 * The single list of rich-text extensions. The editor, static validation,
 * and backup restore all use this so the stored schema stays consistent.
 * Stage 1: paragraphs, headings, lists, quotes, inline code, code blocks,
 * links, bold/italic/underline/strike. Format 4 (Stage 4) adds tables
 * (table, tableRow, tableHeader, tableCell) and internal page links (pageLink).
 */
export const richTextExtensions: Extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: {
      openOnClick: false,
      autolink: true,
      protocols: ['http', 'https', 'mailto'],
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
    },
  }),
  // Columns size automatically to the text box width (no drag-to-resize: it
  // would not follow the pointer on a zoomed page).
  Table.configure({ resizable: false, HTMLAttributes: { class: 'rt-table' } }),
  TableRow,
  SafeTableHeader,
  SafeTableCell,
  PageLink,
  Placeholder.configure({ placeholder: 'Type here…' }),
]

let cachedSchema: Schema | null = null
export function richTextSchema(): Schema {
  cachedSchema ??= getSchema(richTextExtensions)
  return cachedSchema
}

export function emptyDoc(): RichTextDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

export function docFromPlainText(text: string): RichTextDoc {
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n')
  return {
    type: 'doc',
    content: paragraphs.map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  }
}

/**
 * Convert clipboard HTML into a schema-conformant document. Parsing happens in a
 * detached document; anything outside the schema (scripts, styles, frames) is dropped.
 */
export function docFromHtml(html: string): RichTextDoc {
  return generateJSON(html, richTextExtensions) as RichTextDoc
}

const isSpan = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_CELL_SPAN

/**
 * Attribute checks the schema itself does not make. A table cell's spans drive
 * the size of prosemirror-tables' table map, so a huge `colspan` from a damaged
 * backup or an imported file must never reach the editor.
 */
function attrProblem(node: RichTextNode): string | null {
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    const a = node.attrs ?? {}
    if (a.colspan !== undefined && !isSpan(a.colspan)) return `a table cell has an invalid column span`
    if (a.rowspan !== undefined && !isSpan(a.rowspan)) return `a table cell has an invalid row span`
    const w = a.colwidth
    if (w !== undefined && w !== null && !(Array.isArray(w) && w.length <= MAX_CELL_SPAN && w.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_COL_WIDTH))) {
      return 'a table cell has invalid column widths'
    }
  }
  for (const m of node.marks ?? []) {
    if (m.type === PAGE_LINK && !isPageLinkId(m.attrs?.pageId)) return 'a page link has no valid page ID'
    if (m.type === 'link' && typeof m.attrs?.href !== 'string') return 'a link has no address'
  }
  for (const c of node.content ?? []) {
    const p = attrProblem(c)
    if (p) return p
  }
  return null
}

/** Returns null when valid, or a readable reason. */
export function validateRichTextDoc(doc: unknown): string | null {
  try {
    const node = PMNode.fromJSON(richTextSchema(), doc)
    if (node.type.name !== 'doc') return 'root node is not a document'
    node.check()
    return attrProblem(doc as RichTextNode)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function docToPlainText(doc: RichTextDoc): string {
  try {
    const node = PMNode.fromJSON(richTextSchema(), doc)
    return node.textBetween(0, node.content.size, '\n', ' ')
  } catch {
    return ''
  }
}

export function isDocEmpty(doc: RichTextDoc): boolean {
  return docToPlainText(doc).trim().length === 0
}
