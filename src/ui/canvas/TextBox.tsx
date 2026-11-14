import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useServices } from '../../app/context'
import { pageLinkTooltip, pageLinkState } from '../../domain/pageLink'
import { richTextExtensions } from '../../domain/richtext'
import type { RichTextDoc, TextObject } from '../../domain/types'
import { useCanvas } from './CanvasContext'
import { ObjectFrame } from './ObjectFrame'
import { PAGE_LINK_FOLLOW, PAGE_LINK_REQUEST, PageLinkUi, type PageLinkRequestDetail } from './pageLinkUi'

/** Alt+F10 moves focus to the page toolbar (a common editor convention); Esc there returns. */
function focusToolbar(): boolean {
  const first = document.querySelector<HTMLElement>('.toolbar button:not(:disabled)')
  first?.focus()
  return !!first
}

/** Focus synchronously (TipTap defers focus a frame), so the next keystroke lands in the text. */
function focusEnd(editor: Editor): void {
  editor.view.focus()
  editor.commands.focus('end')
}

/** A movable, width-resizable rich-text container. Height follows the content. */
export function TextBox({ obj }: { obj: TextObject }) {
  const api = useCanvas()
  const { store } = useServices()
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const lastDoc = useRef<RichTextDoc>(obj.doc)
  const { pageId, readOnly, registerEditor, focusRequest } = api
  const id = obj.id
  // Editor callbacks always use the latest canvas actions without resubscribing.
  const apiRef = useRef(api)
  const frameRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    apiRef.current = api
    frameRef.current = frame
  })

  const editor = useEditor({
    extensions: [
      ...richTextExtensions,
      PageLinkUi.configure({
        status: (pageId) => {
          const pages = store.getState().data.pages
          return { state: pageLinkState(pageId, pages).state, tooltip: pageLinkTooltip(pageId, pages) }
        },
      }),
    ],
    content: obj.doc,
    editable: !readOnly,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'rt', 'aria-label': 'Note text', 'aria-multiline': 'true', spellcheck: 'true' },
      handlePaste: (_view, event) => apiRef.current.pasteFromEditor(event, id),
      handleKeyDown: (_view, event) => {
        if (event.key === 'Escape') {
          frameRef.current?.focus()
          return true
        }
        if (event.key === 'F10' && event.altKey) return focusToolbar()
        return false
      },
      handleClick: (_view, _pos, event) => {
        if (!(event.ctrlKey || event.metaKey)) return false
        const link = (event.target as HTMLElement).closest('a')
        if (!link || link.hasAttribute('data-page-id') || !link.href) return false
        window.open(link.href, '_blank', 'noopener,noreferrer')
        return true
      },
    },
  })

  useEffect(() => {
    registerEditor(id, editor)
    return () => registerEditor(id, null)
  }, [editor, id, registerEditor])

  useEffect(() => {
    if (editor.isEditable === readOnly) editor.setEditable(!readOnly, false)
  }, [editor, readOnly])

  useEffect(() => {
    const onUpdate = () => {
      const doc = editor.getJSON() as RichTextDoc
      lastDoc.current = doc
      store.setTextDoc(apiRef.current.pageId, id, doc)
    }
    const dom = editor.view.dom
    const onLinkRequest = (e: Event) => {
      const d = (e as CustomEvent<PageLinkRequestDetail>).detail
      apiRef.current.requestPageLink(id, { from: d.from, to: d.to }, d.restore)
    }
    const onLinkFollow = (e: Event) => apiRef.current.followPageLink(String((e as CustomEvent<string>).detail))
    dom.addEventListener(PAGE_LINK_REQUEST, onLinkRequest)
    dom.addEventListener(PAGE_LINK_FOLLOW, onLinkFollow)
    const onFocus = () => apiRef.current.onTextFocus(id)
    const onBlur = () => apiRef.current.onTextBlur(id, editor.isEmpty)
    editor.on('update', onUpdate)
    editor.on('focus', onFocus)
    editor.on('blur', onBlur)
    return () => {
      editor.off('update', onUpdate)
      editor.off('focus', onFocus)
      editor.off('blur', onBlur)
      dom.removeEventListener(PAGE_LINK_REQUEST, onLinkRequest)
      dom.removeEventListener(PAGE_LINK_FOLLOW, onLinkFollow)
    }
  }, [editor, store, id])

  // Content changed outside the editor (canvas undo/redo, reload).
  useEffect(() => {
    if (obj.doc === lastDoc.current) return
    lastDoc.current = obj.doc
    editor.chain().setMeta('addToHistory', false).setContent(obj.doc, { emitUpdate: false }).run()
  }, [editor, obj.doc])

  useEffect(() => {
    if (focusRequest?.id === id && !editor.isFocused) focusEnd(editor)
  }, [editor, focusRequest, id])

  // The stored height follows the rendered text (used for page height and placement).
  useEffect(() => {
    if (!frame) return
    const observer = new ResizeObserver(() => store.setMeasuredHeight(pageId, id, frame.offsetHeight))
    observer.observe(frame)
    return () => observer.disconnect()
  }, [frame, store, pageId, id])

  return (
    <ObjectFrame obj={obj} handles={['w', 'e']} label="Text box" bodyDrag={false} frameRef={setFrame} onEnter={() => focusEnd(editor)}>
      {/* Page links open with Ctrl/Cmd+click, or a plain click when the page is read-only. */}
      <div
        className="obj-text-links"
        onMouseDownCapture={(e) => {
          // Ctrl/Cmd+click follows on press, before the editor moves the cursor.
          const link = (e.target as HTMLElement).closest('a[data-page-id]')
          if (!link || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return
          e.preventDefault()
          e.stopPropagation()
          api.followPageLink(link.getAttribute('data-page-id') ?? '')
        }}
        onClickCapture={(e) => {
          const link = (e.target as HTMLElement).closest('a[data-page-id]')
          if (!link || !readOnly || e.ctrlKey || e.metaKey) return
          e.preventDefault()
          e.stopPropagation()
          api.followPageLink(link.getAttribute('data-page-id') ?? '')
        }}
      >
        <EditorContent editor={editor} className="obj-text-body" />
      </div>
    </ObjectFrame>
  )
}
