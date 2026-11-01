import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useServices } from '../../app/context'
import { richTextExtensions } from '../../domain/richtext'
import type { RichTextDoc, TextObject } from '../../domain/types'
import { useCanvas } from './CanvasContext'
import { ObjectFrame } from './ObjectFrame'

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
    extensions: richTextExtensions,
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
        return false
      },
      handleClick: (_view, _pos, event) => {
        if (!(event.ctrlKey || event.metaKey)) return false
        const link = (event.target as HTMLElement).closest('a')
        if (!link?.href) return false
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
    const onFocus = () => apiRef.current.onTextFocus(id)
    const onBlur = () => apiRef.current.onTextBlur(id, editor.isEmpty)
    editor.on('update', onUpdate)
    editor.on('focus', onFocus)
    editor.on('blur', onBlur)
    return () => {
      editor.off('update', onUpdate)
      editor.off('focus', onFocus)
      editor.off('blur', onBlur)
    }
  }, [editor, store, id])

  // Content changed outside the editor (canvas undo/redo, reload).
  useEffect(() => {
    if (obj.doc === lastDoc.current) return
    lastDoc.current = obj.doc
    editor.chain().setMeta('addToHistory', false).setContent(obj.doc, { emitUpdate: false }).run()
  }, [editor, obj.doc])

  useEffect(() => {
    if (focusRequest?.id === id && !editor.isFocused) editor.commands.focus('end')
  }, [editor, focusRequest, id])

  // The stored height follows the rendered text (used for page height and placement).
  useEffect(() => {
    if (!frame) return
    const observer = new ResizeObserver(() => store.setMeasuredHeight(pageId, id, frame.offsetHeight))
    observer.observe(frame)
    return () => observer.disconnect()
  }, [frame, store, pageId, id])

  return (
    <ObjectFrame obj={obj} handles={['w', 'e']} label="Text box" bodyDrag={false} frameRef={setFrame} onEnter={() => editor.commands.focus('end')}>
      <EditorContent editor={editor} className="obj-text-body" />
    </ObjectFrame>
  )
}
