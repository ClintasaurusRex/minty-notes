import { isDateOnly } from '../domain/dates'
import { pageLinkIds } from '../domain/pageLink'
import { isPageVisible, ownerProjectId, pageCategoryIds, projectReferences, type LibraryData } from '../domain/references'
import type { AttachmentMeta, CanvasObject, Page, PageLocation, WorkspaceRecords } from '../domain/types'
import type { PackageRecords, PackageReference, ReferenceReason } from './format'

/**
 * Decides what a portable project package contains (pure; reads only).
 *
 * Always included: the project record, its live notes, its tasks, the images
 * and imported originals those notes use, and the categories and tags they
 * carry. Library pages (pages no project owns) that the project points at are
 * included as reference snapshots, by these rules:
 *   - pinned     pages pinned to the project (on by default);
 *   - linked     pages that a project note links to in its text, or that a
 *                task links to (on by default) — direct links only: links
 *                inside a snapshot are not followed;
 *   - suggested  library pages suggested by a shared category (off by
 *                default: it can be the whole library for that category).
 *
 * Never included, whatever points at them and whatever is chosen:
 *   - pages hidden for this project (a pin, a link in a note, or a task link
 *     to a hidden page does not bring it along);
 *   - pages that belong to another project;
 *   - pages in the Trash, templates, and the contents of saved file locations
 *     (paths and web links are kept as text).
 * Links to anything left out stay in the text as they are and are counted, and
 * the pages the project points at but that are never packaged are listed, so
 * the export dialog says exactly what is and is not in the file.
 */
export interface ExportOptions {
  includePinned: boolean
  includeLinked: boolean
  includeSuggested: boolean
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { includePinned: true, includeLinked: true, includeSuggested: false }

export type ReferenceGroup = 'pinned' | 'linked' | 'suggested'

export interface ReferenceCandidate {
  pageId: string
  title: string
  /** Where the page lives in this workspace. */
  from: string
  reasons: ReferenceReason[]
  /** Its strongest reason's option (pinned, then linked, then suggested). */
  group: ReferenceGroup
  /** Every option that includes it: it is packed when any one of them is on. */
  groups: ReferenceGroup[]
  included: boolean
}

/** A page the project points at (pin, note link, or task link) that is never put in a package. */
export interface ExcludedReference {
  pageId: string
  title: string
  /** Where the page lives in this workspace. */
  from: string
  /** How the project points at it. */
  reasons: ReferenceReason[]
  why: 'hidden' | 'other-project'
}

export interface ExportSummary {
  projectName: string
  notes: { pageId: string; title: string }[]
  /** Project notes in the Trash (left out). */
  trashedNotes: number
  tasks: { total: number; done: number }
  references: ReferenceCandidate[]
  /** Due dates that are not real calendar dates (stored by an old version); left empty in the package. */
  clearedDueDates: number
  /** Pages hidden for this project (never included). */
  hiddenReferences: number
  /** Pages the project pins or links to that are never included: hidden for this project, or owned by another project. */
  excluded: ExcludedReference[]
  /** Pinned pages that are in the Trash (left out). */
  trashedPinned: number
  images: number
  originals: number
  sketches: number
  attachmentBytes: number
  /** Image files whose page view hides part of them (redaction, blur, or crop) — the package holds the full original. */
  coveredImages: number
  categories: string[]
  tags: string[]
  fileLocations: { paths: number; links: number }
  unresolved: {
    /** Distinct pages linked from included text that are not in the package (by why). */
    linksToTrash: number
    linksToDeleted: number
    /** Linked pages that are hidden for this project (never included). */
    linksToHidden: number
    /** Linked pages that belong to another project (never included). */
    linksToOtherProjects: number
    /** Linked library pages left out by the choices made in the dialog. */
    linksNotIncluded: number
    /** Task links to pages that are not in the package (dropped from the copy). */
    taskLinks: number
  }
}

export interface ProjectSelection {
  records: PackageRecords
  summary: ExportSummary
}

function locationText(location: PageLocation, data: LibraryData): string {
  if (location.kind === 'inbox') return 'Inbox'
  if (location.kind === 'standalone') return 'Standalone notes'
  if (location.kind === 'project') return `Project: ${data.projects[location.projectId]?.name ?? 'unknown'}`
  const section = data.sections[location.sectionId]
  const notebook = section ? data.notebooks[section.notebookId] : undefined
  return section ? `${notebook?.title ?? 'Notebook'} › ${section.title}` : 'Notebook'
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.id, i]))

const GROUP_OF: Record<ReferenceReason, ReferenceGroup> = { pinned: 'pinned', link: 'linked', task: 'linked', suggested: 'suggested' }
const REASON_ORDER: ReferenceReason[] = ['pinned', 'link', 'task', 'suggested']

/**
 * Select the records of one project for a package. `records` must be one
 * consistent snapshot of the workspace. Nothing in it is changed: every
 * record that goes into the package is a copy. Throws if the project is missing.
 */
export function selectProject(records: WorkspaceRecords, projectId: string, options: ExportOptions, exportedAt: string): ProjectSelection {
  const source = records.projects.find((p) => p.id === projectId)
  if (!source) throw new Error('The project no longer exists.')
  const data: LibraryData = { projects: byId(records.projects), categories: byId(records.categories), notebooks: byId(records.notebooks), sections: byId(records.sections), pages: byId(records.pages) }
  const tagsById = byId(records.tags)
  const attachmentsById = byId(records.attachments)
  const objectsByPage = new Map<string, CanvasObject[]>()
  for (const o of records.objects) {
    const list = objectsByPage.get(o.pageId)
    if (list) list.push(o)
    else objectsByPage.set(o.pageId, [o])
  }
  const linksOf = (pageId: string) => (objectsByPage.get(pageId) ?? []).flatMap((o) => (o.type === 'text' ? pageLinkIds(o.doc) : []))

  const owned = records.pages.filter((p) => ownerProjectId(p) === projectId)
  const notes = owned.filter((p) => !p.trashedAt).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const noteIds = new Set(notes.map((p) => p.id))
  const tasks = records.tasks.filter((t) => t.projectId === projectId)

  // ---- reference candidates, in a stable order: pinned, linked from notes, linked from tasks, suggested
  const refs = projectReferences(source, data)
  const reasons = new Map<string, Set<ReferenceReason>>()
  const neverReasons = new Map<string, Set<ReferenceReason>>()
  const hiddenIds = new Set(source.hiddenPageIds)
  /** Why a live page outside this project can never be packaged, or null when it can be a snapshot. */
  const neverPackaged = (page: Page): ExcludedReference['why'] | null => (hiddenIds.has(page.id) ? 'hidden' : ownerProjectId(page) !== null ? 'other-project' : null)
  const consider = (pageId: string, reason: ReferenceReason) => {
    const page = data.pages[pageId]
    // Only live pages outside this project can be snapshots.
    if (!page || ownerProjectId(page) === projectId || !isPageVisible(page, data)) return
    // Hidden pages and other projects' pages are left out however the project reaches them.
    const into = neverPackaged(page) ? neverReasons : reasons
    const set = into.get(pageId)
    if (set) set.add(reason)
    else into.set(pageId, new Set([reason]))
  }
  for (const p of refs.pinned) consider(p.id, 'pinned')
  for (const note of notes) for (const id of linksOf(note.id)) consider(id, 'link')
  for (const t of tasks) for (const id of t.linkedPageIds) consider(id, 'task')
  for (const p of refs.suggested) consider(p.id, 'suggested')

  const enabled: Record<ReferenceGroup, boolean> = { pinned: options.includePinned, linked: options.includeLinked, suggested: options.includeSuggested }
  const candidates: ReferenceCandidate[] = [...reasons].map(([pageId, set]) => {
    const list = REASON_ORDER.filter((r) => set.has(r))
    const page = data.pages[pageId]
    const groups = [...new Set(list.map((r) => GROUP_OF[r]))]
    return { pageId, title: page.title || 'Untitled', from: locationText(page.location, data), reasons: list, group: groups[0], groups, included: groups.some((g) => enabled[g]) }
  })
  const excluded: ExcludedReference[] = [...neverReasons].map(([pageId, set]) => {
    const page = data.pages[pageId]
    return { pageId, title: page.title || 'Untitled', from: locationText(page.location, data), reasons: REASON_ORDER.filter((r) => set.has(r)), why: neverPackaged(page)! }
  })
  const included = candidates.filter((c) => c.included)
  const referenceIds = new Set(included.map((c) => c.pageId))
  const inPackage = (id: string) => noteIds.has(id) || referenceIds.has(id)

  // ---- records (copies; the workspace's own records are never touched)
  const pages: Page[] = []
  notes.forEach((p, i) => {
    const from = p.copiedFrom
    pages.push({
      ...structuredClone(p),
      order: i + 1,
      categoryIds: [...new Set(p.categoryIds.filter((id) => data.categories[id]))],
      tagIds: [...new Set(p.tagIds.filter((id) => tagsById[id]))],
      // A copy remembers its original only when that page comes along.
      copiedFrom: from ? { ...from, pageId: from.pageId && inPackage(from.pageId) ? from.pageId : null } : null,
    })
  })
  const references: PackageReference[] = []
  included.forEach((c, i) => {
    const p = data.pages[c.pageId]
    pages.push({
      ...structuredClone(p),
      // A snapshot belongs to the packaged project and no longer depends on the library it came from:
      // it keeps the categories it had there (its own and those of its section and notebook).
      location: { kind: 'project', projectId },
      order: notes.length + i + 1,
      categoryIds: pageCategoryIds(p, data),
      tagIds: [...new Set(p.tagIds.filter((id) => tagsById[id]))],
      copiedFrom: { pageId: null, title: p.title, at: exportedAt },
      trashedAt: null,
    })
    references.push({ pageId: c.pageId, reasons: c.reasons, from: c.from })
  })

  const objects = pages.flatMap((p) => (objectsByPage.get(p.id) ?? []).map((o) => structuredClone(o)))

  const attachmentIds = new Set<string>()
  const originalIds = new Set<string>()
  for (const p of pages) {
    if (p.importedFrom) {
      attachmentIds.add(p.importedFrom.attachmentId)
      originalIds.add(p.importedFrom.attachmentId)
    }
  }
  const imageIds = new Set<string>()
  const covered = new Set<string>()
  let sketches = 0
  for (const o of objects) {
    if (o.type === 'sketch') sketches++
    if (o.type !== 'image') continue
    attachmentIds.add(o.attachmentId)
    imageIds.add(o.attachmentId)
    if (o.markup && (o.markup.crop || o.markup.items.some((a) => a.kind === 'redact' || a.kind === 'blur'))) covered.add(o.attachmentId)
  }
  const attachments: AttachmentMeta[] = []
  for (const id of attachmentIds) {
    const meta = attachmentsById[id]
    if (!meta) throw new Error('A file used by this project is missing from the workspace, so the project cannot be exported completely.')
    attachments.push({ ...meta })
  }

  // A due date that is not a real date (possible from app 0.2.0) would make the package unreadable.
  const validDue = (v: string | null) => (v === null || isDateOnly(v) ? v : null)
  const clearedDueDates = [source, ...tasks].filter((x) => validDue(x.dueDate) !== x.dueDate).length
  const packagedTasks = tasks
    .map((t) => ({ ...structuredClone(t), dueDate: validDue(t.dueDate), linkedPageIds: [...new Set(t.linkedPageIds.filter(inPackage))] }))
    .sort((a, b) => a.status.localeCompare(b.status) || a.order - b.order || a.id.localeCompare(b.id))
  const taskLinks = tasks.reduce((n, t) => n + t.linkedPageIds.filter((id) => !inPackage(id)).length, 0)

  const categoryIds = new Set([...source.categoryIds.filter((id) => data.categories[id]), ...pages.flatMap((p) => p.categoryIds)])
  const tagIds = new Set(pages.flatMap((p) => p.tagIds))
  const categories = records.categories.filter((c) => categoryIds.has(c.id)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const tags = records.tags.filter((t) => tagIds.has(t.id)).sort((a, b) => a.name.localeCompare(b.name))

  const project = {
    ...structuredClone(source),
    dueDate: validDue(source.dueDate),
    categoryIds: [...new Set(source.categoryIds.filter((id) => data.categories[id]))],
    // Pins become snapshots in the package; the hidden list belongs to the source workspace and never travels.
    pinnedPageIds: [...new Set(source.pinnedPageIds.filter((id) => referenceIds.has(id)))],
    hiddenPageIds: [],
  }

  // ---- links in included text that lead outside the package
  const outside = new Set<string>()
  for (const p of pages) for (const id of linksOf(p.id)) if (!inPackage(id)) outside.add(id)
  let linksToTrash = 0
  let linksToDeleted = 0
  let linksToHidden = 0
  let linksToOtherProjects = 0
  let linksNotIncluded = 0
  for (const id of outside) {
    const target = data.pages[id]
    if (!target) linksToDeleted++
    else if (!isPageVisible(target, data)) linksToTrash++
    else if (neverPackaged(target) === 'hidden') linksToHidden++
    else if (neverPackaged(target) === 'other-project') linksToOtherProjects++
    else linksNotIncluded++
  }

  return {
    records: { project, tasks: packagedTasks, categories: structuredClone(categories), tags: structuredClone(tags), pages, objects, attachments, references },
    summary: {
      projectName: source.name || 'Untitled project',
      notes: notes.map((p) => ({ pageId: p.id, title: p.title || 'Untitled' })),
      trashedNotes: owned.length - notes.length,
      clearedDueDates,
      tasks: { total: tasks.length, done: tasks.filter((t) => t.status === 'done').length },
      references: candidates,
      hiddenReferences: refs.hidden.length,
      excluded,
      trashedPinned: refs.trashedPinned.length,
      images: imageIds.size,
      originals: originalIds.size,
      sketches,
      attachmentBytes: attachments.reduce((n, a) => n + a.size, 0),
      coveredImages: covered.size,
      categories: categories.map((c) => c.name),
      tags: tags.map((t) => t.name),
      fileLocations: { paths: source.fileLocations.filter((f) => f.kind === 'path').length, links: source.fileLocations.filter((f) => f.kind === 'url').length },
      unresolved: { linksToTrash, linksToDeleted, linksToHidden, linksToOtherProjects, linksNotIncluded, taskLinks },
    },
  }
}
