import {
  PAGE_WIDTH,
  newId,
  type CanvasObject,
  type Page,
  type PageLocation,
  type Project,
  type Task,
  type Template,
  type TemplateNote,
  type TemplateObject,
  type TemplateProject,
  type TemplateTask,
  type Timestamp,
} from './types'

/**
 * Reusable note and project templates (pure rules, no storage).
 *
 * A template is a stored snapshot without record IDs. Using it always makes
 * new, independent records with fresh IDs, so a generated note or project never
 * shares anything editable with the template or with other generated copies.
 * Image bytes are shared by attachment ID (bytes never change). Links to
 * library pages stay links (the shared original), exactly like project pins.
 */

/** Snapshot of one page and its objects, without IDs. */
export function noteToTemplate(page: Page, objects: CanvasObject[]): TemplateNote {
  const sorted = [...objects].sort((a, b) => a.z - b.z || a.y - b.y)
  return {
    title: page.title,
    categoryIds: [...page.categoryIds],
    tagIds: [...page.tagIds],
    objects: sorted.map((o): TemplateObject =>
      o.type === 'text'
        ? { type: 'text', x: o.x, y: o.y, w: o.w, h: o.h, z: o.z, doc: structuredClone(o.doc) }
        : { type: 'image', x: o.x, y: o.y, w: o.w, h: o.h, z: o.z, attachmentId: o.attachmentId, alt: o.alt },
    ),
  }
}

export function templateFromPage(page: Page, objects: CanvasObject[], name: string, at: Timestamp): Template {
  return { id: newId(), kind: 'note', name: name.trim() || page.title || 'Note template', description: '', notes: [noteToTemplate(page, objects)], project: null, tasks: [], createdAt: at, updatedAt: at }
}

const isLibrary = (p: Page | undefined): p is Page => !!p && p.location.kind !== 'project'

/**
 * Project template: reusable settings, its live notes, and its open and done
 * tasks (as a fresh To do list). Customer, site, job number, contacts, and
 * dates are left out because they belong to one job. Task links to the
 * project's own notes become links to the generated notes; links to library
 * pages stay shared links; other links are dropped.
 */
export function templateFromProject(
  project: Project,
  notes: { page: Page; objects: CanvasObject[] }[],
  tasks: Task[],
  pages: Record<string, Page>,
  name: string,
  at: Timestamp,
): Template {
  const noteIndex = new Map(notes.map((n, i) => [n.page.id, i]))
  const settings: TemplateProject = {
    status: project.status === 'complete' ? 'active' : project.status,
    description: project.description,
    categoryIds: [...project.categoryIds],
    pinnedPageIds: project.pinnedPageIds.filter((id) => isLibrary(pages[id]) && !pages[id].trashedAt),
    equipment: structuredClone(project.equipment),
    software: structuredClone(project.software),
    fileLocations: structuredClone(project.fileLocations),
  }
  const ordered = [...tasks].sort((a, b) => ['todo', 'doing', 'done'].indexOf(a.status) - ['todo', 'doing', 'done'].indexOf(b.status) || a.order - b.order)
  const templateTasks: TemplateTask[] = ordered.map((t) => ({
    title: t.title,
    description: t.description,
    priority: t.priority,
    noteIndexes: t.linkedPageIds.filter((id) => noteIndex.has(id)).map((id) => noteIndex.get(id)!),
    pageIds: t.linkedPageIds.filter((id) => !noteIndex.has(id) && isLibrary(pages[id]) && !pages[id].trashedAt),
  }))
  return {
    id: newId(),
    kind: 'project',
    name: name.trim() || `${project.name} template`,
    description: '',
    notes: notes.map((n) => noteToTemplate(n.page, n.objects)),
    project: settings,
    tasks: templateTasks,
    createdAt: at,
    updatedAt: at,
  }
}

export interface Existing {
  pages: Record<string, Page>
  categories: Record<string, unknown>
  tags: Record<string, unknown>
  attachments: Record<string, unknown>
}

/** A new page (and objects) from a template note. Missing categories, tags, or image bytes are skipped. */
export function instantiateNote(note: TemplateNote, location: PageLocation, order: number, at: Timestamp, existing: Existing): { page: Page; objects: CanvasObject[] } {
  const page: Page = {
    id: newId(),
    title: note.title || 'Untitled note',
    location,
    order,
    width: PAGE_WIDTH,
    categoryIds: note.categoryIds.filter((id) => id in existing.categories),
    tagIds: note.tagIds.filter((id) => id in existing.tags),
    copiedFrom: null,
    createdAt: at,
    updatedAt: at,
    trashedAt: null,
  }
  const objects: CanvasObject[] = []
  for (const o of note.objects) {
    const base = { id: newId(), pageId: page.id, x: o.x, y: o.y, w: o.w, h: o.h, z: o.z, createdAt: at, updatedAt: at }
    if (o.type === 'text') objects.push({ ...base, type: 'text', doc: structuredClone(o.doc) })
    else if (o.attachmentId in existing.attachments) objects.push({ ...base, type: 'image', attachmentId: o.attachmentId, alt: o.alt })
  }
  return { page, objects }
}

/** Build a new project, its notes, and its tasks from a project template. Every record gets a new ID. */
export function instantiateProject(
  template: Template,
  name: string,
  projectOrder: number,
  at: Timestamp,
  existing: Existing,
  makeProject: (fields: Partial<Project> & { name: string }, order: number, at: Timestamp) => Project,
): { project: Project; pages: Page[]; objects: CanvasObject[]; tasks: Task[] } {
  const s = template.project
  const live = (id: string) => isLibrary(existing.pages[id]) && !existing.pages[id].trashedAt
  const project = makeProject(
    {
      name: name.trim() || template.name,
      status: s?.status ?? 'active',
      description: s?.description ?? '',
      categoryIds: (s?.categoryIds ?? []).filter((id) => id in existing.categories),
      pinnedPageIds: (s?.pinnedPageIds ?? []).filter(live),
      equipment: (s?.equipment ?? []).map((x) => ({ ...x, id: newId() })),
      software: (s?.software ?? []).map((x) => ({ ...x, id: newId() })),
      fileLocations: (s?.fileLocations ?? []).map((x) => ({ ...x, id: newId() })),
    },
    projectOrder,
    at,
  )
  const pages: Page[] = []
  const objects: CanvasObject[] = []
  template.notes.forEach((n, i) => {
    const made = instantiateNote(n, { kind: 'project', projectId: project.id }, i + 1, at, existing)
    pages.push(made.page)
    objects.push(...made.objects)
  })
  const tasks: Task[] = template.tasks.map((t, i) => ({
    id: newId(),
    projectId: project.id,
    title: t.title || 'Untitled task',
    description: t.description,
    status: 'todo',
    priority: t.priority,
    dueDate: null,
    linkedPageIds: [...new Set([...t.noteIndexes.filter((x) => pages[x]).map((x) => pages[x].id), ...t.pageIds.filter(live)])],
    order: i + 1,
    completedAt: null,
    createdAt: at,
    updatedAt: at,
  }))
  return { project, pages, objects, tasks }
}

/** Every page ID a template links to (pins and task links). */
export function templatePageIds(t: Template): string[] {
  return [...(t.project?.pinnedPageIds ?? []), ...t.tasks.flatMap((x) => x.pageIds)]
}

/** Every attachment ID a template's images use. */
export function templateAttachmentIds(t: Template): string[] {
  return t.notes.flatMap((n) => n.objects.flatMap((o) => (o.type === 'image' ? [o.attachmentId] : [])))
}

/**
 * Remove references to categories, tags, or pages that no longer exist (or
 * that `drop` names). Returns the same object when nothing changed.
 */
export function pruneTemplateRefs(t: Template, keep: { category: (id: string) => boolean; tag: (id: string) => boolean; page: (id: string) => boolean }): Template {
  let changed = false
  const filter = (ids: string[], ok: (id: string) => boolean) => {
    const kept = ids.filter(ok)
    if (kept.length !== ids.length) changed = true
    return kept.length !== ids.length ? kept : ids
  }
  const notes = t.notes.map((n) => {
    const categoryIds = filter(n.categoryIds, keep.category)
    const tagIds = filter(n.tagIds, keep.tag)
    return categoryIds === n.categoryIds && tagIds === n.tagIds ? n : { ...n, categoryIds, tagIds }
  })
  const project = t.project
    ? (() => {
        const categoryIds = filter(t.project.categoryIds, keep.category)
        const pinnedPageIds = filter(t.project.pinnedPageIds, keep.page)
        return categoryIds === t.project.categoryIds && pinnedPageIds === t.project.pinnedPageIds ? t.project : { ...t.project, categoryIds, pinnedPageIds }
      })()
    : null
  const tasks = t.tasks.map((x) => {
    const pageIds = filter(x.pageIds, keep.page)
    return pageIds === x.pageIds ? x : { ...x, pageIds }
  })
  return changed ? { ...t, notes, project, tasks } : t
}
