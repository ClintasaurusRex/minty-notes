import { Mark, mergeAttributes } from '@tiptap/core'
import type { Page, RichTextDoc, RichTextNode } from './types'

/**
 * Internal page link (format 4): a mark on ordinary text that points at another
 * page by ID. The text is the user's own words; the destination's current title,
 * Trash state, or deletion is looked up when it is shown, so a moved or renamed
 * page keeps working. A link to a page that was deleted forever stays in the text
 * and is shown as a deleted-page link (it never blocks a backup or restore).
 */
export const PAGE_LINK = 'pageLink'

/** Page IDs are UUIDs; anything else is not a valid link target. */
export function isPageLinkId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 200
}

export const PageLink = Mark.create({
  name: PAGE_LINK,
  // Parsed before the web-link mark, so a pasted Minty page link stays a page link.
  priority: 1100,
  inclusive: false,
  excludes: `${PAGE_LINK} link`,
  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-page-id'),
        renderHTML: (attrs: { pageId?: unknown }) => ({ 'data-page-id': String(attrs.pageId ?? '') }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'a[data-page-id]', getAttrs: (el: HTMLElement) => (isPageLinkId(el.getAttribute('data-page-id')) ? null : false) }]
  },
  renderHTML({ HTMLAttributes }) {
    // No href: it is not a web link and never leaves the app.
    return ['a', mergeAttributes({ class: 'page-link', role: 'link' }, HTMLAttributes), 0]
  },
})

/** Every page ID linked from a document (in document order, without repeats). */
export function pageLinkIds(doc: RichTextDoc | RichTextNode | undefined): string[] {
  const out = new Set<string>()
  const walk = (n: RichTextNode | RichTextDoc | undefined) => {
    if (!n) return
    for (const m of (n as RichTextNode).marks ?? []) if (m.type === PAGE_LINK && isPageLinkId(m.attrs?.pageId)) out.add(m.attrs.pageId)
    for (const c of n.content ?? []) walk(c)
  }
  walk(doc)
  return [...out]
}

export type PageLinkState = 'ok' | 'trashed' | 'missing'

/** How a link to `pageId` should be shown and followed right now. */
export function pageLinkState(pageId: string, pages: Record<string, Page>): { state: PageLinkState; title: string } {
  const page = pages[pageId]
  if (!page) return { state: 'missing', title: '' }
  return { state: page.trashedAt ? 'trashed' : 'ok', title: page.title || 'Untitled' }
}

/** Tooltip text for a page link. */
export function pageLinkTooltip(pageId: string, pages: Record<string, Page>): string {
  const { state, title } = pageLinkState(pageId, pages)
  if (state === 'missing') return 'Linked page was deleted forever'
  if (state === 'trashed') return `Linked page “${title}” is in the Trash`
  return `Linked page: “${title}” — Ctrl+click or Alt+Enter to open`
}
