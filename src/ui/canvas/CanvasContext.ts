import type { Editor } from '@tiptap/react'
import { createContext, useContext } from 'react'

/** Shared state and actions for the objects on one page. */
export interface CanvasApi {
  pageId: string
  pageWidth: number
  scale: number
  readOnly: boolean
  selectedId: string | null
  scroller: HTMLElement | null
  focusRequest: { id: string; seq: number } | null
  select: (id: string | null) => void
  registerEditor: (id: string, editor: Editor | null) => void
  onTextFocus: (id: string) => void
  onTextBlur: (id: string, empty: boolean) => void
  /** Returns true when the paste was handled as image placement. */
  pasteFromEditor: (event: ClipboardEvent, id: string) => boolean
  duplicate: (id: string) => void
  remove: (id: string) => void
  focusPage: () => void
  /** Open the page-link picker for a text box's selection; `restore` is put back on cancel. */
  requestPageLink: (editorId: string, range: { from: number; to: number }, restore: string) => void
  /** Follow an internal page link (handles Trash and deleted targets). */
  followPageLink: (pageId: string) => void
}

export const CanvasContext = createContext<CanvasApi | null>(null)

export function useCanvas(): CanvasApi {
  const api = useContext(CanvasContext)
  if (!api) throw new Error('CanvasContext is missing')
  return api
}
