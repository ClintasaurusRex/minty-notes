import type { Editor } from '@tiptap/react'
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useServices, useWorkspace } from '../../app/context'
import { fitImageSize, fitScale, pageHeight, PAGE_MARGIN } from '../../domain/geometry'
import { docFromHtml, docFromPlainText, emptyDoc, isDocEmpty } from '../../domain/richtext'
import { newId, nowIso, type AttachmentMeta, type CanvasObject, type ImageObject, type Page, type RichTextDoc, type SketchObject, type TextObject } from '../../domain/types'
import { describeStorageError } from '../../storage/repository'
import { ReadOnlyError } from '../../store/workspaceStore'
import { useNav } from '../nav'
import { notify } from '../notices'
import { CanvasContext, type CanvasApi } from './CanvasContext'
import { PageLinkPicker } from './PageLinkPicker'
import { pageLinkStatusKey } from './pageLinkUi'
import { DEFAULT_TEXT_WIDTH, NEW_TEXT_HEIGHT, imageFilesFrom, minZ, nextZ, placeNew, prepareImage } from './canvasActions'
import { ImageBox } from './ImageBox'
import { savePngCopy } from './markupExport'
import { MarkupHost } from './MarkupHost'
import { SketchBox } from './SketchBox'
import { emptyMarkup } from '../../domain/markup'
import { PageHeader } from './PageHeader'
import { TextBox } from './TextBox'
import { Toolbar } from './Toolbar'

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && !!el.closest('input, textarea, select, [contenteditable="true"]')
}

/** A modal dialog (markup editor, page picker, task editor…) owns the keyboard and clipboard. */
function modalOpen(): boolean {
  return !!document.querySelector('dialog[open]')
}

/** Re-draws page-link states (title, Trash, deleted) in open editors whenever pages change. */
function PageLinkRefresher({ editors }: { editors: Record<string, Editor> }) {
  const pages = useWorkspace((s) => s.data.pages)
  useEffect(() => {
    for (const editor of Object.values(editors)) {
      if (editor.isDestroyed || !pageLinkStatusKey.getState(editor.state)?.hasLinks) continue
      editor.view.dispatch(editor.state.tr.setMeta(pageLinkStatusKey, true).setMeta('addToHistory', false))
    }
  }, [pages, editors])
  return null
}

interface LinkRequest {
  editorId: string
  from: number
  to: number
  restore: string
  query: string
}

export function PageView({ pageId, projectId = null, onLeave }: { pageId: string; projectId?: string | null; onLeave: () => void }) {
  const { store } = useServices()
  const nav = useNav()
  const page = useWorkspace((s) => s.data.pages[pageId])
  const objects = useWorkspace((s) => s.data.objects[pageId])
  const readOnly = useWorkspace((s) => s.readOnly)
  const canUndo = useWorkspace(() => store.canUndo(pageId))
  const canRedo = useWorkspace(() => store.canRedo(pageId))

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editors, setEditors] = useState<Record<string, Editor>>({})
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null)
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit')
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  const [linkRequest, setLinkRequest] = useState<LinkRequest | null>(null)
  /** Image or sketch open in the markup editor; `fresh` sketches are removed if left empty. */
  const [markupFor, setMarkupFor] = useState<{ id: string; fresh: boolean } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** Text boxes created in this view; removed again if left empty. */
  const freshIds = useRef(new Set<string>())

  useEffect(() => {
    if (objects) return
    store.ensurePageObjects(pageId).catch((err: unknown) => notify('error', `This page could not be loaded: ${describeStorageError(err)}`))
  }, [objects, pageId, store])

  useEffect(() => {
    if (!scroller) return
    const observer = new ResizeObserver(() => setAvailableWidth(scroller.clientWidth))
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller])

  const pageWidth = page?.width ?? 1200
  const scale = zoom === 'fit' ? fitScale(availableWidth - 48, pageWidth) : 1
  const list = objects ? Object.values(objects).sort((a, b) => a.y - b.y || a.x - b.x) : []
  const height = pageHeight(list)
  const selected = selectedId && objects?.[selectedId] ? objects[selectedId] : null
  const activeEditor = selected?.type === 'text' ? (editors[selected.id] ?? null) : null

  const select = (id: string | null) => setSelectedId(id)

  const registerEditor = useCallback((id: string, editor: Editor | null) => {
    setEditors((prev) => {
      if (editor ? prev[id] === editor : !(id in prev)) return prev
      const next = { ...prev }
      if (editor) next[id] = editor
      else delete next[id]
      return next
    })
  }, [])

  const guard = (fn: () => void) => {
    try {
      fn()
    } catch (err) {
      if (err instanceof ReadOnlyError) notify('info', err.message)
      else throw err
    }
  }

  const focusObject = (id: string) => {
    requestAnimationFrame(() => {
      const el = pageEl?.querySelector<HTMLElement>(`[data-object-id="${id}"]`)
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el?.focus({ preventScroll: true })
    })
  }

  const focusPage = () => pageEl?.focus({ preventScroll: true })

  /** Top of the visible part of the page, in page coordinates. */
  const viewportTop = () => {
    if (!scroller || !pageEl) return 0
    return Math.max(0, (scroller.getBoundingClientRect().top - pageEl.getBoundingClientRect().top) / scale)
  }

  const toPagePoint = (clientX: number, clientY: number) => {
    const r = pageEl!.getBoundingClientRect()
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale }
  }

  const currentObjects = (): CanvasObject[] => Object.values(store.getState().data.objects[pageId] ?? {})

  const addTextBox = (at?: { x: number; y: number }, doc: RichTextDoc = emptyDoc()) =>
    guard(() => {
      const all = currentObjects()
      const anchor = selectedId ? (store.getObject(pageId, selectedId) ?? null) : null
      const rect = placeNew({ w: Math.min(DEFAULT_TEXT_WIDTH, pageWidth - 2 * PAGE_MARGIN), h: NEW_TEXT_HEIGHT }, { objects: all, pageWidth, anchor, viewportTop: viewportTop() }, at)
      const at2 = nowIso()
      const obj: TextObject = { id: newId(), pageId, type: 'text', ...rect, z: nextZ(all), doc, createdAt: at2, updatedAt: at2 }
      store.addObjects(pageId, [obj], 'Add text')
      if (isDocEmpty(doc)) freshIds.current.add(obj.id)
      setSelectedId(obj.id)
      setFocusRequest({ id: obj.id, seq: Date.now() })
    })

  const addSketch = () =>
    guard(() => {
      const all = currentObjects()
      const anchor = selectedId ? (store.getObject(pageId, selectedId) ?? null) : null
      const rect = placeNew({ w: Math.min(640, pageWidth - 2 * PAGE_MARGIN), h: 400 }, { objects: all, pageWidth, anchor, viewportTop: viewportTop() })
      const ts = nowIso()
      const obj: SketchObject = { id: newId(), pageId, type: 'sketch', ...rect, z: nextZ(all), markup: emptyMarkup(rect.w, rect.h), createdAt: ts, updatedAt: ts }
      store.addObjects(pageId, [obj], 'Add sketch')
      setSelectedId(obj.id)
      setMarkupFor({ id: obj.id, fresh: true })
    })

  const insertImages = async (files: Blob[], source: AttachmentMeta['source'], at?: { x: number; y: number }, anchorId?: string | null) => {
    if (readOnly) return notify('info', 'This window is read-only.')
    const created: ImageObject[] = []
    let anchor: CanvasObject | null = (anchorId ?? selectedId) ? (store.getObject(pageId, (anchorId ?? selectedId)!) ?? null) : null
    let point = at
    for (const file of files) {
      try {
        const { meta, blob } = await prepareImage(file, source)
        // Bytes are stored before any object refers to them.
        await store.addAttachment(meta, blob)
        const size = fitImageSize(meta.width ?? 400, meta.height ?? 300, window.devicePixelRatio || 1, pageWidth - 2 * PAGE_MARGIN)
        const all = [...currentObjects(), ...created]
        const rect = placeNew(size, { objects: all, pageWidth, anchor, viewportTop: viewportTop() }, point)
        const ts = nowIso()
        const img: ImageObject = { id: newId(), pageId, type: 'image', attachmentId: meta.id, alt: '', ...rect, z: nextZ(all), createdAt: ts, updatedAt: ts }
        created.push(img)
        anchor = img
        point = undefined
      } catch (err) {
        notify('error', `An image could not be added: ${err instanceof Error && err.message === 'The image could not be read.' ? err.message : describeStorageError(err)}`)
      }
    }
    if (created.length === 0) return
    guard(() => store.addObjects(pageId, created, created.length > 1 ? 'Add images' : 'Add image'))
    const last = created[created.length - 1]
    setSelectedId(last.id)
    focusObject(last.id)
  }

  const pasteFromEditor = (event: ClipboardEvent, id: string): boolean => {
    const images = imageFilesFrom(event.clipboardData)
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (images.length === 0 || text.trim()) return false
    void insertImages(images, 'paste', undefined, id)
    return true
  }

  // Paste outside a text box: images become image objects; text becomes a new text box.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || readOnly || modalOpen()) return
      const images = imageFilesFrom(event.clipboardData)
      const text = event.clipboardData?.getData('text/plain') ?? ''
      const html = event.clipboardData?.getData('text/html') ?? ''
      if (images.length > 0 && !text.trim()) {
        event.preventDefault()
        void insertImages(images, 'paste')
        return
      }
      if (isTypingTarget(event.target)) return
      if (text.trim() || html) {
        event.preventDefault()
        addTextBox(undefined, html ? docFromHtml(html) : docFromPlainText(text))
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  const focusedEditor = () => Object.values(editors).find((e) => e.isFocused) ?? null

  const undo = () => {
    const ed = focusedEditor()
    if (ed) ed.commands.undo()
    else store.undo(pageId)
  }
  const redo = () => {
    const ed = focusedEditor()
    if (ed) ed.commands.redo()
    else store.redo(pageId)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readOnly || isTypingTarget(e.target) || modalOpen()) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && !e.altKey && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) store.redo(pageId)
        else store.undo(pageId)
      } else if (mod && !e.altKey && key === 'y') {
        e.preventDefault()
        store.redo(pageId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readOnly, store, pageId])

  const remove = (id: string) =>
    guard(() => {
      freshIds.current.delete(id)
      store.removeObjects(pageId, [id])
      setSelectedId(null)
      focusPage()
    })

  const duplicate = (id: string) =>
    guard(() => {
      const src = store.getObject(pageId, id)
      if (!src) return
      const all = currentObjects()
      const ts = nowIso()
      const copy = { ...src, id: newId(), x: Math.min(src.x + 24, Math.max(0, pageWidth - src.w)), y: src.y + 24, z: nextZ(all), createdAt: ts, updatedAt: ts } as CanvasObject
      store.addObjects(pageId, [copy], 'Duplicate')
      setSelectedId(copy.id)
      focusObject(copy.id)
    })

  const api: CanvasApi = {
    pageId,
    pageWidth,
    scale,
    readOnly,
    selectedId: selected?.id ?? null,
    scroller,
    focusRequest,
    select,
    registerEditor,
    onTextFocus: (id) => {
      setSelectedId(id)
      if (focusRequest?.id === id) setFocusRequest(null)
      if (!readOnly) store.beginTextSession(pageId, id)
    },
    onTextBlur: (id, empty) => {
      // Switching to another app (e.g. a screenshot tool) is not leaving the text box.
      if (!document.hasFocus()) return
      store.endTextSession()
      if (empty && freshIds.current.has(id) && !readOnly) {
        freshIds.current.delete(id)
        store.discardObject(pageId, id)
      }
    },
    pasteFromEditor,
    duplicate,
    remove,
    focusPage,
    requestPageLink: (editorId, range, restore) => {
      const editor = editors[editorId]
      if (readOnly || !editor) return
      setLinkRequest({ editorId, ...range, restore, query: range.from === range.to ? '' : editor.state.doc.textBetween(range.from, range.to, ' ').slice(0, 80) })
    },
    followPageLink: (id) => nav.followPageLink(id),
    openMarkup: (id) => {
      if (readOnly) return notify('info', 'This window is read-only, so markup cannot be changed here.')
      const o = store.getObject(pageId, id)
      if (o && o.type !== 'text') setMarkupFor({ id, fresh: false })
    },
  }

  const markupObj = markupFor ? store.getObject(pageId, markupFor.id) : undefined
  const closeMarkup = (patch: Partial<CanvasObject> | null) => {
    const target = markupFor
    setMarkupFor(null)
    if (!target) return
    const obj = store.getObject(pageId, target.id)
    if (!obj || obj.type === 'text') return
    guard(() => {
      if (patch) store.updateObjects(pageId, [{ id: obj.id, patch }], obj.type === 'sketch' ? 'Edit sketch' : 'Mark up image')
      // A new sketch left empty is removed, like an empty new text box.
      const now = store.getObject(pageId, obj.id)
      if (target.fresh && now?.type === 'sketch' && now.markup.items.length === 0) store.discardObject(pageId, obj.id)
    })
    focusObject(obj.id)
  }

  const closeLinkPicker = (pageToLink: Page | null) => {
    const req = linkRequest
    setLinkRequest(null)
    const editor = req ? editors[req.editorId] : undefined
    if (!req || !editor || editor.isDestroyed) return
    // The picker has already closed its dialog (and the browser has returned
    // focus to the text), so the selection restored here is the one that stays.
    const chain = editor.chain().focus().setTextSelection({ from: req.from, to: req.to })
    if (!pageToLink) {
      if (req.restore) chain.insertContentAt(req.from, req.restore)
      chain.run()
      return
    }
    const mark = { type: 'pageLink', attrs: { pageId: pageToLink.id } }
    if (req.from !== req.to) chain.setMark('pageLink', mark.attrs).setTextSelection(req.to).run()
    else chain.insertContentAt(req.from, { type: 'text', text: pageToLink.title || 'Untitled page', marks: [mark] }).run()
  }

  const onBackgroundPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    setSelectedId(null)
    const active = document.activeElement
    if (active instanceof HTMLElement && pageEl?.contains(active)) active.blur()
    focusPage()
  }

  const onBackgroundDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || readOnly) return
    const p = toPagePoint(e.clientX, e.clientY)
    addTextBox({ x: p.x, y: p.y - 12 })
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (readOnly || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const images = imageFilesFrom(e.dataTransfer)
    if (readOnly || images.length === 0) return
    e.preventDefault()
    void insertImages(images, 'drop', toPagePoint(e.clientX, e.clientY))
  }

  if (!page) return null

  const zOrder = (front: boolean) =>
    selected &&
    guard(() => {
      const all = currentObjects().filter((o) => o.id !== selected.id)
      if (all.length === 0) return
      store.updateObjects(pageId, [{ id: selected.id, patch: { z: front ? nextZ(all) : minZ(all) - 1 } }], front ? 'Bring to front' : 'Send to back')
    })

  return (
    <CanvasContext.Provider value={api}>
      <div className="page-view">
        <PageHeader page={page as Page} projectId={projectId} onLeave={onLeave} zoom={zoom} scale={scale} onZoom={setZoom} />
        <PageLinkRefresher editors={editors} />
        {markupObj && markupObj.type !== 'text' && <MarkupHost key={markupObj.id} obj={markupObj} pageWidth={pageWidth} onDone={(patch) => closeMarkup(patch)} onCancel={() => closeMarkup(null)} />}
        {linkRequest && <PageLinkPicker currentPageId={pageId} initialQuery={linkRequest.query} onChoose={(p) => closeLinkPicker(p)} onCancel={() => closeLinkPicker(null)} />}
        <Toolbar
          readOnly={readOnly}
          canUndo={canUndo || !!focusedEditor()}
          canRedo={canRedo || !!focusedEditor()}
          onUndo={undo}
          onRedo={redo}
          onAddText={() => addTextBox()}
          onAddImage={() => fileInput.current?.click()}
          onAddSketch={addSketch}
          onMarkup={() => selected && selected.type !== 'text' && api.openMarkup(selected.id)}
          onSavePng={() => {
            if (!selected || selected.type === 'text') return
            const name = selected.type === 'image' ? (store.getState().data.attachments[selected.attachmentId]?.fileName ?? 'image') : 'Sketch'
            void savePngCopy(selected, (id) => store.getBlob(id), name)
          }}
          editor={activeEditor}
          selected={selected}
          pageWidth={pageWidth}
          onArrange={(patch) => selected && guard(() => store.updateObjects(pageId, [{ id: selected.id, patch }], 'Arrange'))}
          onFront={() => zOrder(true)}
          onBack={() => zOrder(false)}
          onDuplicate={() => selected && duplicate(selected.id)}
          onDelete={() => selected && remove(selected.id)}
          onPageLink={() => {
            if (!activeEditor || !selected) return
            const { from, to } = activeEditor.state.selection
            api.requestPageLink(selected.id, { from, to }, '')
          }}
          onFollowLink={(id) => nav.followPageLink(id)}
        />
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/avif,image/svg+xml"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length) void insertImages(files, 'file')
          }}
        />
        <div className="canvas-scroller" ref={setScroller}>
          {objects ? (
            <div className="page-frame" style={{ width: pageWidth * scale, height: height * scale }}>
              <div
                ref={setPageEl}
                className="page"
                style={{ width: pageWidth, height, transform: `scale(${scale})` }}
                tabIndex={-1}
                role="region"
                aria-label={`Page: ${page.title}`}
                data-testid="page-surface"
                onPointerDown={onBackgroundPointerDown}
                onDoubleClick={onBackgroundDoubleClick}
                onDragOver={onDragOver}
                onDrop={onDrop}
              >
                {list.map((o) => (o.type === 'text' ? <TextBox key={o.id} obj={o} /> : o.type === 'sketch' ? <SketchBox key={o.id} obj={o} /> : <ImageBox key={o.id} obj={o} />))}
                {list.length === 0 && (
                  <div className="page-empty" aria-hidden="true">
                    <p>Double-click anywhere to write, or use “Text”.</p>
                    <p>Paste a screenshot with Ctrl+V.</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="muted pad">Loading page…</p>
          )}
        </div>
      </div>
    </CanvasContext.Provider>
  )
}
