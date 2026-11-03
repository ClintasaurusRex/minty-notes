import { Extension, getMarkRange, InputRule } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { PAGE_LINK, type PageLinkState } from '../../domain/pageLink'

export interface PageLinkStatus {
  state: PageLinkState
  tooltip: string
}

export interface PageLinkUiOptions {
  /** Current state of a link target (read at render time, so it is always fresh). */
  status: (pageId: string) => PageLinkStatus
}

/**
 * DOM events fired on the editor element. The text box listens for them:
 * `request` opens the page picker (`restore` is text to put back on cancel),
 * `follow` opens a linked page.
 */
export const PAGE_LINK_REQUEST = 'minty-page-link-request'
export const PAGE_LINK_FOLLOW = 'minty-page-link-follow'
export interface PageLinkRequestDetail {
  from: number
  to: number
  restore: string
}

export const pageLinkStatusKey = new PluginKey<{ decorations: DecorationSet; hasLinks: boolean }>('pageLinkStatus')

/** The page link at (or touching) the cursor or selection start, if any. */
export function pageLinkAt(state: EditorState): string | null {
  const { $from, empty } = state.selection
  const candidates = [...$from.marks(), ...(empty ? [...($from.nodeBefore?.marks ?? []), ...($from.nodeAfter?.marks ?? [])] : ($from.nodeAfter?.marks ?? []))]
  const mark = candidates.find((m) => m.type.name === PAGE_LINK)
  return mark ? (mark.attrs.pageId as string) : null
}

/** Range of the page link around the cursor (for "Remove link"). */
export function pageLinkRange(state: EditorState): { from: number; to: number } | null {
  const id = pageLinkAt(state)
  const type = state.schema.marks[PAGE_LINK]
  if (!id || !type) return null
  return getMarkRange(state.selection.$from, type, { pageId: id }) ?? null
}

function fire(el: Element, type: string, detail: unknown): void {
  el.dispatchEvent(new CustomEvent(type, { detail }))
}

function decorate(doc: PMNode, status: PageLinkUiOptions['status']): { decorations: DecorationSet; hasLinks: boolean } {
  const decos: Decoration[] = []
  let hasLinks = false
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === PAGE_LINK)
    if (!mark) return
    hasLinks = true
    const s = status(String(mark.attrs.pageId))
    const attrs: Record<string, string> = { class: `page-link-state page-link-${s.state}`, title: s.tooltip }
    if (s.state === 'trashed') attrs['data-link-note'] = 'in Trash'
    if (s.state === 'missing') attrs['data-link-note'] = 'deleted'
    decos.push(Decoration.inline(pos, pos + node.nodeSize, attrs))
  })
  return { decorations: DecorationSet.create(doc, decos), hasLinks }
}

/**
 * Editor-only behaviour for page links (no schema changes): shows each link's
 * live state (title tooltip, in Trash, deleted), opens the page picker on `[[`
 * or Ctrl+Shift+K, and follows the link at the cursor with Alt+Enter.
 */
export const PageLinkUi = Extension.create<PageLinkUiOptions>({
  name: 'pageLinkUi',
  addOptions() {
    return { status: () => ({ state: 'ok', tooltip: '' }) }
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-k': () => {
        const { from, to } = this.editor.state.selection
        fire(this.editor.view.dom, PAGE_LINK_REQUEST, { from, to, restore: '' } satisfies PageLinkRequestDetail)
        return true
      },
      'Alt-Enter': () => {
        const id = pageLinkAt(this.editor.state)
        if (!id) return false
        fire(this.editor.view.dom, PAGE_LINK_FOLLOW, id)
        return true
      },
    }
  },
  addInputRules() {
    return [
      new InputRule({
        find: /\[\[$/,
        handler: ({ state, range }) => {
          state.tr.delete(range.from, range.to)
          const at = state.tr.mapping.map(range.from)
          // Let this transaction finish before the picker takes focus.
          const dom = this.editor.view.dom
          queueMicrotask(() => fire(dom, PAGE_LINK_REQUEST, { from: at, to: at, restore: '[[' } satisfies PageLinkRequestDetail))
        },
      }),
    ]
  },
  addProseMirrorPlugins() {
    const status = this.options.status
    return [
      new Plugin({
        key: pageLinkStatusKey,
        state: {
          init: (_config, state) => decorate(state.doc, status),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(pageLinkStatusKey) ? decorate(tr.doc, status) : old),
        },
        props: {
          decorations: (state) => pageLinkStatusKey.getState(state)?.decorations,
        },
      }),
    ]
  },
})
