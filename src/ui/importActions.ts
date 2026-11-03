import { generateHTML } from '@tiptap/core'
import { fitImageSize } from '../domain/geometry'
import { docFromPlainText, richTextExtensions } from '../domain/richtext'
import type { PageLocation, RichTextDoc } from '../domain/types'
import { importDocument, type ImportBlock } from '../import/importDocument'
import { ReadOnlyError, type ImportedObject, type WorkspaceStore } from '../store/workspaceStore'
import { notify } from './notices'

const DRAFT_X = 48
const DRAFT_TOP = 48
const DRAFT_WIDTH = 860
const DRAFT_GAP = 20

/**
 * Measure how tall a text box will be, using the same CSS as the editor, so
 * the imported sections are stacked without overlapping. (The editor measures
 * again when the page opens.)
 */
function createMeasurer(width: number): { height: (doc: RichTextDoc) => number; dispose: () => void } {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout'
  const frame = document.createElement('div')
  frame.className = 'obj obj-text'
  frame.style.position = 'relative'
  frame.style.width = `${width}px`
  const body = document.createElement('div')
  body.className = 'obj-text-body'
  const rt = document.createElement('div')
  rt.className = 'rt ProseMirror'
  body.append(rt)
  frame.append(body)
  host.append(frame)
  document.body.append(host)
  return {
    height(doc) {
      // Schema-generated HTML only (known elements and attributes).
      rt.innerHTML = generateHTML(doc, richTextExtensions)
      return Math.ceil(frame.offsetHeight) + 8
    },
    dispose: () => host.remove(),
  }
}

/** Stack the converted sections and pictures down the page. */
export function layoutImport(blocks: ImportBlock[]): ImportedObject[] {
  const measurer = createMeasurer(DRAFT_WIDTH)
  const out: ImportedObject[] = []
  let y = DRAFT_TOP
  try {
    for (const b of blocks) {
      if (b.kind === 'text') {
        const h = measurer.height(b.doc)
        out.push({ type: 'text', x: DRAFT_X, y, w: DRAFT_WIDTH, h, doc: b.doc })
        y += h + DRAFT_GAP
      } else {
        const { w, h } = fitImageSize(b.width, b.height, 1, DRAFT_WIDTH)
        out.push({ type: 'image', x: DRAFT_X, y, w, h, attachmentId: b.file.meta.id, alt: '' })
        y += h + DRAFT_GAP
      }
    }
  } finally {
    measurer.dispose()
  }
  return out
}

let busy = false

/**
 * Import one DOCX or PDF into `location`: the original is stored unchanged,
 * an editable draft page is created, and the page opens. A file that is a
 * real DOCX/PDF but cannot be converted can still be kept (after asking).
 */
export async function importFileTo(file: File, location: PageLocation, store: WorkspaceStore, openPage: (pageId: string, projectId: string | null) => void): Promise<void> {
  if (busy) return notify('info', 'Another document is still being imported.')
  if (store.getState().readOnly) return notify('info', 'This window is read-only.')
  busy = true
  const projectId = location.kind === 'project' ? location.projectId : null
  try {
    notify('info', `Importing “${file.name}”…`, 6000)
    const outcome = await importDocument(file)
    if (!outcome.ok) {
      if (!outcome.original || !outcome.format) return notify('error', outcome.reason)
      const keep = window.confirm(`${outcome.reason}\n\nKeep the original file in Minty Notes anyway? It is stored unchanged on a new page (without an editable draft) and is included in backups.`)
      if (!keep) return notify('info', 'Nothing was imported.')
      const explanation = docFromPlainText(`${outcome.reason}\n\nThe original file is attached to this page unchanged. Use “Preview original” or “Download original” above.`)
      const page = await store.createImportedPage(location, {
        title: outcome.title ?? file.name,
        importedFrom: { attachmentId: outcome.original.meta.id, fileName: outcome.original.meta.fileName, format: outcome.format, notes: [outcome.reason] },
        files: [outcome.original],
        objects: layoutImport([{ kind: 'text', doc: explanation }]),
      })
      openPage(page.id, projectId)
      notify('success', `Kept the original “${file.name}” (not converted).`)
      return
    }
    const objects = layoutImport(outcome.blocks)
    const images = outcome.blocks.flatMap((b) => (b.kind === 'image' ? [b.file] : []))
    const page = await store.createImportedPage(location, {
      title: outcome.title,
      importedFrom: { attachmentId: outcome.original.meta.id, fileName: outcome.original.meta.fileName, format: outcome.format, notes: outcome.notes },
      files: [outcome.original, ...images],
      objects,
    })
    openPage(page.id, projectId)
    notify('success', `Imported “${file.name}” as an editable draft (${outcome.summary}). The original file is kept unchanged. Check the conversion notes at the top of the page.`, 8000)
  } catch (err) {
    notify(err instanceof ReadOnlyError ? 'info' : 'error', `“${file.name}” was not imported: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy = false
  }
}
