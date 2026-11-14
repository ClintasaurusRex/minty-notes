import { Node as PMNode } from '@tiptap/pm/model'
import { richTextSchema } from '../domain/richtext'
import type { Annotation, AttachmentMeta, CanvasObject, Category, Contact, FileLocation, Markup, Page, Project, ProjectItem, RichTextDoc, RichTextNode, Tag, Task } from '../domain/types'
import { isOriginalOnly } from '../import/formats'
import type { PackageRecords, PackageReference, ReferenceReason } from './format'

/**
 * Rebuilds validated package records from their known fields only, so nothing
 * else a package might carry (extra properties, unknown rich-text attributes,
 * unusual timestamp spellings, unsafe link addresses) can reach the workspace.
 * Call only after the records passed validation.
 */

const iso = (v: string): string => new Date(Date.parse(v)).toISOString()
const isoOrNull = (v: string | null): string | null => (v === null ? null : iso(v))

/** Schemes a link in a note may use (the same set the editor itself accepts). */
const SAFE_SCHEME = /^(?:https?|ftps?|mailto|tel|callto|sms|cid|xmpp):/i
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i
// Characters browsers ignore inside a scheme (used to disguise "java\tscript:").
// eslint-disable-next-line no-control-regex
const IGNORED_IN_URL = /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g

const LINK_REL = 'noopener noreferrer nofollow'

/** True for an address that cannot run script: a known scheme, or no scheme at all. */
export function isSafeHref(href: string): boolean {
  const clean = href.replace(IGNORED_IN_URL, '')
  return SAFE_SCHEME.test(clean) || !ANY_SCHEME.test(clean)
}

/**
 * A document in the editor's own canonical form (schema-known nodes, marks,
 * and attributes only), without link marks whose address is not safe — the
 * linked words stay (`removed` counts those links) — and with the editor's
 * own target/rel on every remaining web link.
 */
export function cleanDoc(doc: RichTextDoc, removed: { links: number }): RichTextDoc {
  const strip = (node: RichTextNode): RichTextNode => {
    const out: RichTextNode = { ...node }
    if (node.marks) {
      const marks = node.marks
        .filter((m) => {
          const unsafe = m.type === 'link' && !isSafeHref(String(m.attrs?.href ?? ''))
          if (unsafe) removed.links++
          return !unsafe
        })
        // A web link always opens the way the editor's own links do (new tab, no access to this window).
        .map((m) => (m.type === 'link' ? { type: 'link', attrs: { href: String(m.attrs?.href), target: '_blank', rel: LINK_REL, class: null, title: typeof m.attrs?.title === 'string' ? m.attrs.title.slice(0, 2000) : null } } : m))
      if (marks.length > 0) out.marks = marks
      else delete out.marks
    }
    if (node.content) out.content = node.content.map(strip)
    return out
  }
  const canonical = PMNode.fromJSON(richTextSchema(), doc).toJSON() as RichTextDoc
  return strip(canonical as unknown as RichTextNode) as unknown as RichTextDoc
}

function cleanAnnotation(a: Annotation): Annotation {
  switch (a.kind) {
    case 'arrow':
    case 'line':
      return { id: a.id, kind: a.kind, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, color: a.color, width: a.width }
    case 'rect':
    case 'ellipse':
      return { id: a.id, kind: a.kind, x: a.x, y: a.y, w: a.w, h: a.h, color: a.color, width: a.width, fill: a.fill }
    case 'text':
      return { id: a.id, kind: a.kind, x: a.x, y: a.y, text: a.text, color: a.color, size: a.size, background: a.background }
    case 'pen':
    case 'highlighter':
      return { id: a.id, kind: a.kind, points: [...a.points], color: a.color, width: a.width }
    case 'blur':
    case 'redact':
      return { id: a.id, kind: a.kind, x: a.x, y: a.y, w: a.w, h: a.h }
  }
}

function cleanMarkup(m: Markup): Markup {
  return { width: m.width, height: m.height, crop: m.crop ? { x: m.crop.x, y: m.crop.y, w: m.crop.w, h: m.crop.h } : null, items: m.items.map(cleanAnnotation) }
}

function cleanObject(o: CanvasObject, removed: { links: number }): CanvasObject {
  const base = { id: o.id, pageId: o.pageId, x: o.x, y: o.y, w: o.w, h: o.h, z: o.z, createdAt: iso(o.createdAt), updatedAt: iso(o.updatedAt) }
  if (o.type === 'text') return { ...base, type: 'text', doc: cleanDoc(o.doc, removed) }
  if (o.type === 'sketch') return { ...base, type: 'sketch', markup: cleanMarkup(o.markup) }
  return { ...base, type: 'image', attachmentId: o.attachmentId, alt: o.alt, ...(o.markup ? { markup: cleanMarkup(o.markup) } : {}) }
}

function cleanProject(p: Project): Project {
  const item = (x: ProjectItem): ProjectItem => ({ id: x.id, name: x.name, detail: x.detail })
  return {
    id: p.id,
    name: p.name,
    customer: p.customer,
    site: p.site,
    jobNumber: p.jobNumber,
    status: p.status,
    dueDate: p.dueDate,
    description: p.description,
    contacts: p.contacts.map((c): Contact => ({ id: c.id, name: c.name, role: c.role, phone: c.phone, email: c.email })),
    equipment: p.equipment.map(item),
    software: p.software.map(item),
    fileLocations: p.fileLocations.map((f): FileLocation => ({ id: f.id, label: f.label, kind: f.kind, value: f.value, description: f.description })),
    categoryIds: [...p.categoryIds],
    pinnedPageIds: [...p.pinnedPageIds],
    hiddenPageIds: [],
    order: p.order,
    archivedAt: isoOrNull(p.archivedAt),
    trashedAt: isoOrNull(p.trashedAt),
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  }
}

function cleanPage(p: Page): Page {
  const page: Page = {
    id: p.id,
    title: p.title,
    location: { kind: 'project', projectId: (p.location as { projectId: string }).projectId },
    order: p.order,
    width: p.width,
    categoryIds: [...p.categoryIds],
    tagIds: [...p.tagIds],
    copiedFrom: p.copiedFrom ? { pageId: p.copiedFrom.pageId, title: p.copiedFrom.title, at: iso(p.copiedFrom.at) } : null,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    trashedAt: null,
  }
  if (p.importedFrom) {
    const f = p.importedFrom
    page.importedFrom = { attachmentId: f.attachmentId, fileName: f.fileName, format: f.format, importedAt: iso(f.importedAt), notes: [...f.notes] }
  }
  return page
}

const cleanTask = (t: Task): Task => ({
  id: t.id,
  projectId: t.projectId,
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  dueDate: t.dueDate,
  linkedPageIds: [...new Set(t.linkedPageIds)],
  order: t.order,
  completedAt: isoOrNull(t.completedAt),
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
})

const cleanCategory = (c: Category): Category => ({ id: c.id, name: c.name, order: c.order, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt) })
const cleanTag = (t: Tag): Tag => ({ id: t.id, name: t.name, createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt) })
const cleanAttachment = (a: AttachmentMeta): AttachmentMeta => ({ id: a.id, fileName: a.fileName, mimeType: a.mimeType, size: a.size, sha256: a.sha256, width: a.width, height: a.height, source: a.source, createdAt: iso(a.createdAt) })
const cleanReference = (r: PackageReference): PackageReference => ({ pageId: r.pageId, reasons: [...new Set(r.reasons)] as ReferenceReason[], from: r.from })

/**
 * File name for an imported original: no path or control characters, and
 * always ending in the extension of the format its bytes were verified as, so
 * “Download original” can never hand out a file that pretends to be a document.
 */
export function safeOriginalName(name: string, format: 'docx' | 'pdf'): string {
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim() || 'document'
  return base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`
}

export function cleanPackageRecords(r: PackageRecords): { records: PackageRecords; unsafeLinks: number; renamedOriginals: number } {
  const removed = { links: 0 }
  const records: PackageRecords = {
    project: cleanProject(r.project),
    tasks: r.tasks.map(cleanTask),
    categories: r.categories.map(cleanCategory),
    tags: r.tags.map(cleanTag),
    pages: r.pages.map(cleanPage),
    objects: r.objects.map((o) => cleanObject(o, removed)),
    attachments: r.attachments.map(cleanAttachment),
    references: r.references.map(cleanReference),
  }
  // Originals keep their name unless it could mislead about what the file is.
  let renamedOriginals = 0
  const attachments = new Map(records.attachments.map((a) => [a.id, a]))
  for (const page of records.pages) {
    const from = page.importedFrom
    if (!from) continue
    const name = safeOriginalName(from.fileName, from.format)
    const meta = attachments.get(from.attachmentId)
    if (meta) meta.fileName = name
    if (name === from.fileName) continue
    renamedOriginals++
    // An “original only” page is recognised by its first note, which quotes the file name.
    if (isOriginalOnly(from)) from.notes[0] = `“${name}”${from.notes[0].slice(`“${from.fileName}”`.length)}`
    from.fileName = name
  }
  return { records, unsafeLinks: removed.links, renamedOriginals }
}
