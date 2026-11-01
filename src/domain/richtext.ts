import { getSchema, generateJSON, type Extensions } from '@tiptap/core'
import { Node as PMNode, type Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import type { RichTextDoc } from './types'

/**
 * The single list of rich-text extensions. The editor, static validation,
 * and backup restore all use this so the stored schema stays consistent.
 * Stage 1 scope: paragraphs, headings, lists, quotes, inline code, code
 * blocks, links, bold/italic/underline/strike.
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

/** Returns null when valid, or a readable reason. */
export function validateRichTextDoc(doc: unknown): string | null {
  try {
    const node = PMNode.fromJSON(richTextSchema(), doc)
    if (node.type.name !== 'doc') return 'root node is not a document'
    node.check()
    return null
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
