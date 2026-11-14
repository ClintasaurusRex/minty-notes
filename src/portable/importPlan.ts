import { Checker, validateRecords } from '../backup/archive'
import { PAGE_LINK, pageLinkIds } from '../domain/pageLink'
import { normalize } from '../domain/search'
import { newId, nowIso, type AttachmentMeta, type CanvasObject, type Category, type Page, type Project, type RichTextDoc, type RichTextNode, type Tag, type Task } from '../domain/types'
import { emptyChangeSet, type ImportBatch } from '../storage/repository'
import type { WorkspaceData } from '../store/workspaceStore'
import type { ValidPackage } from './readPackage'

/**
 * Turns a validated package into the new records to add to a workspace (pure).
 *
 * Every imported record gets a NEW ID, and every relationship is rebuilt
 * through an explicit old → new map per record kind, so a link can only point
 * at a record imported from the same package — never at a workspace record
 * that happens to have the same ID. The only existing records an import ever
 * links to are:
 *   - categories and tags with the same name (a category is identified by its
 *     name everywhere in the app; the existing record is used as it is), and
 *   - library pages the user explicitly chose to reuse (see `reuseCandidates`).
 * Existing records are never changed.
 */

export type ImportDestination = Pick<WorkspaceData, 'workspace' | 'projects' | 'tasks' | 'templates' | 'categories' | 'tags' | 'notebooks' | 'sections' | 'pages' | 'attachments'>

export interface ImportOptions {
  /** Link reference pages that are already in this library instead of importing snapshot copies of them. */
  reuseExisting: boolean
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { reuseExisting: false }

export interface ReuseCandidate {
  /** The page's ID (the same in the package and in this workspace). */
  pageId: string
  title: string
}

export interface ImportPreview {
  /** Name the project gets here. */
  projectName: string
  /** Set when another project already uses the package's name. */
  renamedFrom: string | null
  categories: { name: string; existing: boolean }[]
  tags: { name: string; existing: boolean }[]
  reuseCandidates: ReuseCandidate[]
}

export interface ImportCounts {
  notes: number
  /** Reference pages imported as independent copies. */
  snapshots: number
  /** Reference pages linked to existing library pages instead (only when asked). */
  linkedExisting: number
  tasks: number
  objects: number
  attachments: number
  newCategories: number
  newTags: number
  /** Distinct link targets that were not in the package (kept as unavailable links). */
  unresolvedLinks: number
}

export interface ImportPlan {
  batch: ImportBatch
  projectId: string
  projectName: string
  preview: ImportPreview
  counts: ImportCounts
  /** Old (package) ID → ID in this workspace, per record kind. */
  idMap: {
    project: [string, string]
    pages: Map<string, string>
    objects: Map<string, string>
    tasks: Map<string, string>
    attachments: Map<string, string>
    categories: Map<string, string>
    tags: Map<string, string>
    /** Link targets that are not in the package → a fresh ID that belongs to no page. */
    unresolvedLinks: Map<string, string>
  }
  /** Existing library pages the project links to (only when reuse was asked for). */
  reusedPageIds: string[]
}

const key = (name: string) => normalize(name.trim())

/**
 * The name the imported project gets. An unused name is kept; otherwise
 * “Name (imported)”, then “Name (imported 2)”, and so on — compared without
 * regard to letter case or accents, against every project including archived
 * and trashed ones, so neither project is lost or mistaken for the other.
 */
export function uniqueProjectName(name: string, projects: Iterable<{ name: string }>): string {
  const base = name.trim() || 'Untitled project'
  const taken = new Set<string>()
  for (const p of projects) taken.add(key(p.name))
  if (!taken.has(key(base))) return base
  for (let n = 1; ; n++) {
    const candidate = `${base} (imported${n === 1 ? '' : ` ${n}`})`
    if (!taken.has(key(candidate))) return candidate
  }
}

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b)

/**
 * Reference pages in the package that are the very same pages as ones in this
 * library: the package came from this workspace (same workspace ID, e.g. a
 * second computer restored from the same backup), and a live library page has
 * the same ID and creation time. Only these can be linked instead of copied,
 * and only when the user asks; a matching title or category is never enough.
 */
export function reuseCandidates(pkg: ValidPackage, dest: ImportDestination): ReuseCandidate[] {
  if (!pkg.summary.sourceWorkspaceId || dest.workspace?.workspaceId !== pkg.summary.sourceWorkspaceId) return []
  const pages = new Map(pkg.records.pages.map((p) => [p.id, p]))
  const out: ReuseCandidate[] = []
  for (const ref of pkg.records.references) {
    const existing = Object.hasOwn(dest.pages, ref.pageId) ? dest.pages[ref.pageId] : undefined
    const packaged = pages.get(ref.pageId)
    if (!existing || !packaged || existing.trashedAt || existing.location.kind === 'project' || !sameInstant(existing.createdAt, packaged.createdAt)) continue
    out.push({ pageId: existing.id, title: existing.title || 'Untitled' })
  }
  return out
}

function byName<T extends { id: string; name: string }>(items: Record<string, T>, order: (a: T, b: T) => number): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of Object.values(items).sort(order)) if (!map.has(key(item.name))) map.set(key(item.name), item)
  return map
}

const categoryOrder = (a: Category, b: Category) => a.order - b.order || a.id.localeCompare(b.id)
const tagOrder = (a: Tag, b: Tag) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/** What importing would look like here (name, labels, reusable pages), without building anything. */
export function previewProjectImport(pkg: ValidPackage, dest: ImportDestination): ImportPreview {
  const name = pkg.records.project.name.trim() || 'Untitled project'
  const projectName = uniqueProjectName(name, Object.values(dest.projects))
  const categories = byName(dest.categories, categoryOrder)
  const tags = byName(dest.tags, tagOrder)
  const distinct = (items: { name: string }[], existing: Map<string, unknown>) => {
    const seen = new Set<string>()
    return items.flatMap((x) => (seen.has(key(x.name)) ? [] : (seen.add(key(x.name)), [{ name: x.name, existing: existing.has(key(x.name)) }])))
  }
  return { projectName, renamedFrom: projectName === name ? null : name, categories: distinct(pkg.records.categories, categories), tags: distinct(pkg.records.tags, tags), reuseCandidates: reuseCandidates(pkg, dest) }
}

/** A copy of `doc` with every page-link target replaced through `target`. */
function remapPageLinks(doc: RichTextDoc, target: (pageId: string) => string): RichTextDoc {
  const walk = (node: RichTextNode): RichTextNode => {
    const out: RichTextNode = { ...node }
    if (node.marks) out.marks = node.marks.map((m) => (m.type === PAGE_LINK ? { ...m, attrs: { ...m.attrs, pageId: target(String(m.attrs?.pageId)) } } : { ...m }))
    if (node.content) out.content = node.content.map(walk)
    return out
  }
  return walk(doc as unknown as RichTextNode) as unknown as RichTextDoc
}

/**
 * Build the records to add. Deterministic: with the same package, workspace,
 * options, and ID source, the result is the same. `makeId` must return new
 * unused IDs; anything already used here or in the package is asked for again.
 */
export function planProjectImport(pkg: ValidPackage, dest: ImportDestination, options: ImportOptions = DEFAULT_IMPORT_OPTIONS, makeId: () => string = newId, at: string = nowIso()): ImportPlan {
  const r = pkg.records
  const preview = previewProjectImport(pkg, dest)

  // ---- new IDs: never one that exists in this workspace or anywhere in the package
  const used = new Set<string>()
  for (const kind of ['projects', 'tasks', 'templates', 'categories', 'tags', 'notebooks', 'sections', 'pages', 'attachments'] as const) for (const id of Object.keys(dest[kind])) used.add(id)
  for (const id of [r.project.id, ...r.tasks.map((x) => x.id), ...r.categories.map((x) => x.id), ...r.tags.map((x) => x.id), ...r.pages.map((x) => x.id), ...r.objects.map((x) => x.id), ...r.attachments.map((x) => x.id)]) used.add(id)
  for (const o of r.objects) if (o.type === 'text') for (const id of pageLinkIds(o.doc)) used.add(id)
  const fresh = (): string => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = makeId()
      if (typeof id === 'string' && id.length > 0 && id.length <= 200 && !used.has(id)) {
        used.add(id)
        return id
      }
    }
    throw new Error('Minty Notes could not create unused IDs for the imported records. Nothing was imported.')
  }

  const changes = emptyChangeSet()
  const mustExist: ImportBatch['mustExist'] = []
  const projectId = fresh()

  // ---- categories and tags: the existing record with the same name, or a new one
  const mapLabels = <T extends { id: string; name: string }>(items: T[], existing: Map<string, T>, store: 'categories' | 'tags', make: (item: T) => T): Map<string, string> => {
    const map = new Map<string, string>()
    const made = new Map<string, string>()
    for (const item of items) {
      const k = key(item.name)
      const found = existing.get(k)
      if (found) {
        map.set(item.id, found.id)
        if (!mustExist.some((m) => m.store === store && m.id === found.id)) mustExist.push({ store, id: found.id })
        continue
      }
      let id = made.get(k)
      if (!id) {
        const record = make(item)
        id = record.id
        made.set(k, id)
        ;(changes[store] as Map<string, T | null>).set(id, record)
      }
      map.set(item.id, id)
    }
    return map
  }
  let nextCategoryOrder = Object.values(dest.categories).reduce((max, c) => Math.max(max, c.order), 0)
  const categoryMap = mapLabels<Category>(r.categories, byName(dest.categories, categoryOrder), 'categories', (c) => ({ id: fresh(), name: c.name.trim(), order: ++nextCategoryOrder, createdAt: at, updatedAt: at }))
  const tagMap = mapLabels<Tag>(r.tags, byName(dest.tags, tagOrder), 'tags', (t) => ({ id: fresh(), name: t.name.trim(), createdAt: at, updatedAt: at }))
  const mapList = (ids: string[], map: Map<string, string>) => [...new Set(ids.flatMap((id) => (map.has(id) ? [map.get(id)!] : [])))]

  // ---- pages: a new ID each, except reference pages the user chose to link to existing library pages
  const referenceIds = new Set(r.references.map((x) => x.pageId))
  const reused = new Set(options.reuseExisting ? preview.reuseCandidates.map((c) => c.pageId) : [])
  const pageMap = new Map<string, string>()
  const imported = [...r.pages].filter((p) => !reused.has(p.id)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  for (const p of imported) pageMap.set(p.id, fresh())
  for (const id of reused) {
    pageMap.set(id, id)
    mustExist.push({ store: 'pages', id })
  }

  // ---- attachments: only those the imported pages use
  const importedPageIds = new Set(imported.map((p) => p.id))
  const neededAttachments = new Set<string>()
  for (const p of imported) if (p.importedFrom) neededAttachments.add(p.importedFrom.attachmentId)
  for (const o of r.objects) if (o.type === 'image' && importedPageIds.has(o.pageId)) neededAttachments.add(o.attachmentId)
  const attachmentMap = new Map<string, string>()
  const attachments: ImportBatch['attachments'] = []
  for (const meta of r.attachments) {
    if (!neededAttachments.has(meta.id)) continue
    const blob = pkg.blobs.get(meta.id)
    if (!blob) throw new Error(`The file “${meta.fileName}” is missing from the package. Nothing was imported.`)
    const id = fresh()
    attachmentMap.set(meta.id, id)
    attachments.push({ meta: { ...meta, id } satisfies AttachmentMeta, blob })
  }

  // ---- page links in text: imported page → its new ID; anything else → an ID no page has
  const unresolved = new Map<string, string>()
  const linkTarget = (old: string): string => {
    const mapped = pageMap.get(old)
    if (mapped) return mapped
    let dead = unresolved.get(old)
    if (!dead) {
      dead = fresh()
      unresolved.set(old, dead)
    }
    return dead
  }

  imported.forEach((p, i) => {
    const isReference = referenceIds.has(p.id)
    const from = p.copiedFrom
    const page: Page = {
      id: pageMap.get(p.id)!,
      title: p.title,
      location: { kind: 'project', projectId },
      order: i + 1,
      width: p.width,
      categoryIds: mapList(p.categoryIds, categoryMap),
      tagIds: mapList(p.tagIds, tagMap),
      // A snapshot is an independent copy whose original is not in this workspace.
      copiedFrom: isReference ? { pageId: null, title: from?.title ?? p.title, at: from?.at ?? at } : from ? { pageId: from.pageId !== null && pageMap.has(from.pageId) ? pageMap.get(from.pageId)! : null, title: from.title, at: from.at } : null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      trashedAt: null,
    }
    if (p.importedFrom) page.importedFrom = { ...p.importedFrom, attachmentId: attachmentMap.get(p.importedFrom.attachmentId)!, notes: [...p.importedFrom.notes] }
    changes.pages.set(page.id, page)
  })

  const objectMap = new Map<string, string>()
  for (const o of r.objects) {
    if (!importedPageIds.has(o.pageId)) continue
    const id = fresh()
    objectMap.set(o.id, id)
    const base = { id, pageId: pageMap.get(o.pageId)!, x: o.x, y: o.y, w: o.w, h: o.h, z: o.z, createdAt: o.createdAt, updatedAt: o.updatedAt }
    let object: CanvasObject
    if (o.type === 'text') object = { ...base, type: 'text', doc: remapPageLinks(o.doc, linkTarget) }
    else if (o.type === 'sketch') object = { ...base, type: 'sketch', markup: structuredClone(o.markup) }
    else object = { ...base, type: 'image', attachmentId: attachmentMap.get(o.attachmentId)!, alt: o.alt, ...(o.markup ? { markup: structuredClone(o.markup) } : {}) }
    changes.objects.set(id, object)
  }

  const taskMap = new Map<string, string>()
  for (const t of r.tasks) {
    const id = fresh()
    taskMap.set(t.id, id)
    const task: Task = { ...t, id, projectId, linkedPageIds: mapList(t.linkedPageIds, pageMap) }
    changes.tasks.set(id, task)
  }

  const p = r.project
  const project: Project = {
    ...p,
    id: projectId,
    name: preview.projectName,
    contacts: p.contacts.map((x) => ({ ...x, id: fresh() })),
    equipment: p.equipment.map((x) => ({ ...x, id: fresh() })),
    software: p.software.map((x) => ({ ...x, id: fresh() })),
    fileLocations: p.fileLocations.map((x) => ({ ...x, id: fresh() })),
    categoryIds: mapList(p.categoryIds, categoryMap),
    // Snapshots are the project's own pages now; only explicitly reused library pages are links.
    pinnedPageIds: [...reused],
    hiddenPageIds: [],
    order: Object.values(dest.projects).reduce((max, x) => Math.max(max, x.order), 0) + 1,
    archivedAt: null,
    trashedAt: null,
    updatedAt: at,
  }
  changes.projects.set(projectId, project)

  const snapshots = imported.filter((x) => referenceIds.has(x.id)).length
  return {
    batch: { changes, attachments, mustExist },
    projectId,
    projectName: project.name,
    preview,
    counts: {
      notes: imported.length - snapshots,
      snapshots,
      linkedExisting: reused.size,
      tasks: changes.tasks.size,
      objects: changes.objects.size,
      attachments: attachments.length,
      newCategories: changes.categories.size,
      newTags: changes.tags.size,
      unresolvedLinks: unresolved.size,
    },
    idMap: { project: [p.id, projectId], pages: pageMap, objects: objectMap, tasks: taskMap, attachments: attachmentMap, categories: categoryMap, tags: tagMap, unresolvedLinks: unresolved },
    reusedPageIds: [...reused],
  }
}

/**
 * Check a finished plan against the workspace before anything is written:
 * the new records must form a valid, self-contained set (the same checks as a
 * backup restore), must not reuse any existing ID, and every link must lead to
 * a record of this import (or one of the explicitly reused existing records).
 * Throws with the reasons; an import that fails here writes nothing.
 */
export function verifyImportPlan(plan: ImportPlan, dest: ImportDestination): void {
  const problems: string[] = []
  const c = new Checker(problems)
  const { changes, attachments, mustExist } = plan.batch
  const values = <T>(map: Map<string, T | null>): T[] => [...map.values()].filter((v): v is T => v !== null)
  const projects = values(changes.projects)
  const pages = values(changes.pages)
  const objects = values(changes.objects)
  const tasks = values(changes.tasks)

  // No new ID may exist here already, and no ID may be used twice in the import.
  const all = new Set<string>()
  const claim = (id: string) => {
    c.require(!all.has(id), 'The import uses the same ID twice.')
    all.add(id)
  }
  for (const kind of ['projects', 'tasks', 'categories', 'tags', 'pages'] as const) {
    for (const [id, value] of changes[kind]) {
      c.require(value !== null && value.id === id, 'The import contains an invalid record.')
      c.require(!Object.hasOwn(dest[kind], id), 'The import would replace a record that is already in this workspace.')
      claim(id)
    }
  }
  for (const [id, value] of changes.objects) {
    c.require(value !== null && value.id === id, 'The import contains an invalid record.')
    claim(id)
  }
  for (const a of attachments) {
    c.require(!Object.hasOwn(dest.attachments, a.meta.id), 'The import would replace a file that is already in this workspace.')
    c.require(a.blob.size === a.meta.size, 'A file in the import does not have the size it claims.')
    claim(a.meta.id)
  }
  c.require(changes.templates.size === 0 && changes.notebooks.size === 0 && changes.sections.size === 0, 'The import contains records a project package cannot hold.')
  c.require(projects.length === 1 && projects[0]?.id === plan.projectId, 'The import does not contain exactly one project.')

  // Existing records the import links to (same-name labels, explicitly reused pages).
  const existing = { categories: new Set<string>(), tags: new Set<string>(), pages: new Set<string>() }
  for (const m of mustExist) {
    if (m.store !== 'categories' && m.store !== 'tags' && m.store !== 'pages') {
      c.fail('The import depends on an unexpected kind of existing record.')
      continue
    }
    c.require(Object.hasOwn(dest[m.store], m.id), 'Something the import links to is no longer in this workspace.')
    existing[m.store].add(m.id)
  }
  c.require([...existing.pages].every((id) => plan.reusedPageIds.includes(id)), 'The import links to an existing page that was not chosen.')

  // Every relationship resolves inside the import (or to an explicitly reused existing record).
  const newPages = new Set(pages.map((x) => x.id))
  const newAttachments = new Set(attachments.map((a) => a.meta.id))
  const knownPage = (id: string) => newPages.has(id) || existing.pages.has(id)
  const dead = new Set(plan.idMap.unresolvedLinks.values())
  for (const page of pages) {
    c.require(page.location.kind === 'project' && page.location.projectId === plan.projectId, 'An imported page does not belong to the imported project.')
    c.require(!page.copiedFrom?.pageId || knownPage(page.copiedFrom.pageId), 'An imported copy points at a page outside the import.')
    c.require(!page.importedFrom || newAttachments.has(page.importedFrom.attachmentId), 'An imported page points at an original file outside the import.')
  }
  for (const o of objects) {
    c.require(newPages.has(o.pageId), 'An imported object belongs to a page outside the import.')
    if (o.type === 'image') c.require(newAttachments.has(o.attachmentId), 'An imported picture uses a file outside the import.')
    if (o.type === 'text') for (const id of pageLinkIds(o.doc)) c.require(knownPage(id) || (dead.has(id) && !Object.hasOwn(dest.pages, id)), 'A link in an imported note would lead to a page that is not part of the import.')
  }
  for (const t of tasks) {
    c.require(t.projectId === plan.projectId, 'An imported task does not belong to the imported project.')
    c.require(t.linkedPageIds.every(knownPage), 'An imported task links to a page outside the import.')
  }
  const project = projects[0]
  if (project) {
    c.require(project.pinnedPageIds.every((id) => existing.pages.has(id)) && project.hiddenPageIds.length === 0, 'The imported project links to a page that was not chosen.')
    c.require(!project.trashedAt && !project.archivedAt, 'The imported project would be hidden.')
  }

  // The same record and relationship checks a backup restore makes, on the new records
  // together with stand-ins for the existing records they link to.
  if (problems.length === 0) {
    const stamp = new Date(0).toISOString()
    const standIn = (id: string): Page => ({ id, title: '', location: { kind: 'standalone' }, order: 0, width: 1200, categoryIds: [], tagIds: [], copiedFrom: null, createdAt: stamp, updatedAt: stamp, trashedAt: null })
    validateRecords(
      {
        workspace: { workspaceId: 'import', formatVersion: 0, createdAt: stamp },
        projects,
        tasks,
        templates: [],
        categories: [...values(changes.categories), ...[...existing.categories].map((id) => dest.categories[id])],
        tags: [...values(changes.tags), ...[...existing.tags].map((id) => dest.tags[id])],
        notebooks: [],
        sections: [],
        pages: [...pages, ...[...existing.pages].map(standIn)],
        objects,
        attachments: attachments.map((a) => a.meta),
      },
      c,
    )
  }
  if (problems.length > 0) throw new Error(`The import was stopped before anything was written, because the prepared records did not pass their final check: ${problems.slice(0, 3).join(' ')}`)
}
