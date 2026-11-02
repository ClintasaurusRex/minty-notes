import { docToPlainText } from '../domain/richtext'
import { pruneTemplateRefs, templatePageIds } from '../domain/templates'
import {
  PAGE_WIDTH,
  newId,
  type CanvasObject,
  type Category,
  type ImageObject,
  type Notebook,
  type Page,
  type Project,
  type RichTextDoc,
  type RichTextNode,
  type Section,
  type Tag,
  type Task,
  type Template,
  type TextObject,
} from '../domain/types'
import { emptyChangeSet, type ChangeSet } from '../storage/repository'

/**
 * Held-edit reconciliation.
 *
 * A window that lost editing rights keeps its unsaved changes as
 * (base, mine) pairs: `base` is the stored record this window last knew,
 * `mine` is what it wanted to store (null = delete). When it becomes the
 * editor again, each pair is merged field by field against the latest stored
 * record (`theirs`):
 *
 *   - a field only this window changed      → this window's value
 *   - a field only the other window changed → the other window's value
 *   - a field both changed differently      → conflict: stored value kept,
 *                                             this window's value recovered
 *
 * Changes to records deleted elsewhere are never resurrected, and a deletion
 * here never removes a record that changed elsewhere. Everything that cannot be
 * applied safely goes into a separate "Recovered changes" note in the Inbox.
 * Bookkeeping fields (`updatedAt`) never count as an intended change.
 *
 * ID lists (categories, tags, a project's pinned/hidden references, a task's
 * linked notes) are merged
 * as sets — additions and removals from both windows are kept — and afterwards
 * every link is checked, so nothing points at a record that no longer exists.
 */

export type RecordKind = 'projects' | 'tasks' | 'templates' | 'categories' | 'tags' | 'notebooks' | 'sections' | 'pages' | 'objects'
type AnyRecord = Project | Task | Template | Category | Tag | Notebook | Section | Page | CanvasObject

export interface HeldChange {
  kind: RecordKind
  id: string
  base: AnyRecord | null
  mine: AnyRecord | null
}

export interface LatestRecords {
  projects: Record<string, Project>
  tasks: Record<string, Task>
  templates: Record<string, Template>
  categories: Record<string, Category>
  tags: Record<string, Tag>
  notebooks: Record<string, Notebook>
  sections: Record<string, Section>
  pages: Record<string, Page>
  /** Every stored object of each page the held changes touch. */
  objects: Record<string, CanvasObject>
}

export type RecoveredItem =
  | { type: 'text'; source: string; reason: string; doc: RichTextDoc }
  | { type: 'image'; source: string; reason: string; image: ImageObject }
  | { type: 'note'; source: string; reason: string; detail: string }

export interface ReconcileResult {
  /** Writes to apply (merged records, safe deletions, and the recovery note). */
  changes: ChangeSet
  /** Number of held changes that were applied (fully or partly). */
  applied: number
  /** Items placed in the recovery note. */
  recovered: RecoveredItem[]
  /** Held changes that turned out to be no-ops or already identical. */
  unchanged: number
  recoveryPageId: string | null
}

const IGNORED_FIELDS = new Set(['updatedAt'])
/** Fields holding lists of IDs; merged as sets instead of conflicting. */
const SET_FIELDS = new Set(['categoryIds', 'tagIds', 'pinnedPageIds', 'hiddenPageIds', 'linkedPageIds'])

/** theirs + what this window added − what this window removed (theirs' order first). */
function mergeIdSets(base: string[], mine: string[], theirs: string[]): string[] {
  const b = new Set(base)
  const m = new Set(mine)
  const out = theirs.filter((id) => !(b.has(id) && !m.has(id)))
  for (const id of mine) if (!b.has(id) && !out.includes(id)) out.push(id)
  return out
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  )
}

export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

/** True when `mine` differs from `base` in anything other than bookkeeping fields. */
export function isIntendedChange(base: AnyRecord | null, mine: AnyRecord | null): boolean {
  if (!base || !mine) return base !== mine
  const keys = new Set([...Object.keys(base), ...Object.keys(mine)])
  for (const k of keys) {
    if (IGNORED_FIELDS.has(k)) continue
    if (!sameValue((base as unknown as Record<string, unknown>)[k], (mine as unknown as Record<string, unknown>)[k])) return true
  }
  return false
}

interface FieldMerge<T> {
  result: T
  changed: boolean
  conflicts: string[]
}

/** Three-way merge of one record. `derived` fields never conflict (stored value wins). */
function mergeFields<T extends AnyRecord>(base: T, mine: T, theirs: T, derived: string[], now: string): FieldMerge<T> {
  const b = base as unknown as Record<string, unknown>
  const m = mine as unknown as Record<string, unknown>
  const t = theirs as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...t }
  const conflicts: string[] = []
  let changed = false
  for (const k of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
    if (IGNORED_FIELDS.has(k)) continue
    if (sameValue(m[k], b[k])) continue // only theirs (or nobody) changed it
    if (SET_FIELDS.has(k) && Array.isArray(m[k]) && Array.isArray(t[k])) {
      out[k] = mergeIdSets(Array.isArray(b[k]) ? (b[k] as string[]) : [], m[k] as string[], t[k] as string[])
      changed = true
      continue
    }
    if (sameValue(t[k], b[k])) {
      out[k] = m[k] // only mine changed it
      changed = true
    } else if (!sameValue(m[k], t[k]) && !derived.includes(k)) {
      conflicts.push(k) // both changed it differently: keep theirs
    }
  }
  if (changed) out.updatedAt = now
  return { result: out as unknown as T, changed, conflicts }
}

function describeLocation(p: Page, latest: LatestRecords): string {
  if (p.location.kind === 'inbox') return 'Inbox'
  if (p.location.kind === 'standalone') return 'Standalone notes'
  if (p.location.kind === 'project') return `project “${latest.projects[p.location.projectId]?.name ?? 'deleted'}”`
  const s = latest.sections[p.location.sectionId]
  return s ? `${latest.notebooks[s.notebookId]?.title ?? 'Notebook'} › ${s.title}` : 'a deleted section'
}

function fieldText(kind: RecordKind, field: string, value: unknown, latest: LatestRecords): string {
  if (kind === 'pages' && field === 'location') return describeLocation({ location: value } as Page, latest)
  if (field === 'trashedAt') return value ? 'in the Trash' : 'not in the Trash'
  if (field === 'archivedAt') return value ? 'archived' : 'not archived'
  if (typeof value === 'string' || typeof value === 'number') return String(value) || '(empty)'
  if (value === null || value === undefined) return '(empty)'
  if (Array.isArray(value)) {
    const lookup: Record<string, Record<string, { name?: string; title?: string }>> = { categoryIds: latest.categories, tagIds: latest.tags, pinnedPageIds: latest.pages, hiddenPageIds: latest.pages, linkedPageIds: latest.pages }
    const names = value.map((v) => {
      if (typeof v === 'string') return lookup[field]?.[v]?.name ?? lookup[field]?.[v]?.title ?? v
      const o = v as Record<string, string>
      return [o.name ?? o.label ?? o.title, o.detail ?? o.role ?? o.value].filter(Boolean).join(' — ')
    })
    return names.length ? names.join(', ') : '(none)'
  }
  if (field === 'copiedFrom') return `copy of “${(value as { title?: string }).title ?? ''}”`
  return stable(value)
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  name: 'Name',
  location: 'Location',
  trashedAt: 'Trash state',
  archivedAt: 'Archive state',
  order: 'Order',
  notebookId: 'Notebook',
  customer: 'Customer',
  site: 'Site',
  jobNumber: 'Job number',
  status: 'Status',
  dueDate: 'Due date',
  description: 'Description',
  contacts: 'Contacts',
  equipment: 'Equipment',
  software: 'Software versions',
  fileLocations: 'File locations',
  categoryIds: 'Categories',
  tagIds: 'Tags',
  pinnedPageIds: 'Pinned references',
  hiddenPageIds: 'Hidden references',
  priority: 'Priority',
  linkedPageIds: 'Linked notes',
  notes: 'Template notes',
  tasks: 'Template tasks',
  project: 'Project settings',
}

const inProject = (p: Page, projectId: string) => p.location.kind === 'project' && p.location.projectId === projectId

/** Put back IDs this window removed only because of a deletion that is being refused. */
function restoreIds<T extends AnyRecord>(mine: T, base: T, field: string, refused: Set<string>): T {
  const b = (base as unknown as Record<string, unknown>)[field]
  const m = (mine as unknown as Record<string, unknown>)[field]
  if (!Array.isArray(b) || !Array.isArray(m)) return mine
  const back = (b as string[]).filter((id) => refused.has(id) && !(m as string[]).includes(id))
  return back.length ? ({ ...mine, [field]: [...(m as string[]), ...back] } as T) : mine
}

/**
 * A deletion held in this window is refused (step 2) when the other window
 * changed the record or still uses it. The changes this window made only as
 * part of that deletion must then be dropped too — otherwise a kept project
 * would lose its notes to the Trash, a kept category or tag would be removed
 * from everything, or a kept page would lose its content, pins, hides, and the
 * source link of its project copies. This predicts the refusals with the same
 * rules as step 2 and removes those side effects before anything is merged.
 */
export function withoutRefusedCascades(held: HeldChange[], latest: LatestRecords): HeldChange[] {
  const theirsOf = (h: HeldChange) => (latest[h.kind] as Record<string, AnyRecord>)[h.id] as AnyRecord | undefined
  const deletions = (kind: RecordKind) => held.filter((h) => h.kind === kind && !h.mine && h.base && theirsOf(h))
  const refused = { pages: new Set<string>(), projects: new Set<string>(), categories: new Set<string>(), tags: new Set<string>() }
  // Tasks this window deletes that the other window did not change.
  const tasksGone = new Set(deletions('tasks').filter((h) => !isIntendedChange(h.base, theirsOf(h)!)).map((h) => h.id))

  for (const kind of ['categories', 'tags'] as const) {
    for (const h of deletions(kind)) if (isIntendedChange(h.base, theirsOf(h)!)) refused[kind].add(h.id)
  }
  // Objects this window deletes that the other window did not change (those deletions go ahead).
  const objectsGone = new Set(deletions('objects').filter((h) => !isIntendedChange(h.base, theirsOf(h)!)).map((h) => h.id))
  for (const h of held) if (h.kind === 'objects' && !h.mine && !theirsOf(h)) objectsGone.add(h.id)
  for (const h of deletions('pages')) {
    const stillHasContent = Object.values(latest.objects).some((o) => o.pageId === h.id && !objectsGone.has(o.id))
    if (isIntendedChange(h.base, theirsOf(h)!) || stillHasContent) refused.pages.add(h.id)
  }
  for (const h of deletions('projects')) {
    // Notes this window moved out as part of deleting the project (to the Inbox, in the Trash).
    const movedOut = new Set(
      held
        .filter((x) => x.kind === 'pages' && x.base && x.mine && inProject(x.base as Page, h.id) && (x.mine as Page).location.kind === 'inbox' && (x.mine as Page).trashedAt)
        .map((x) => x.id),
    )
    const stillUsed =
      Object.values(latest.pages).some((p) => inProject(p, h.id) && !movedOut.has(p.id)) || Object.values(latest.tasks).some((t) => t.projectId === h.id && !tasksGone.has(t.id))
    if (isIntendedChange(h.base, theirsOf(h)!) || stillUsed) refused.projects.add(h.id)
  }
  if (Object.values(refused).every((s) => s.size === 0)) return held

  const out: HeldChange[] = []
  for (const h of held) {
    // The content of a page whose deletion is refused stays.
    if (h.kind === 'objects' && !h.mine && h.base && refused.pages.has((h.base as CanvasObject).pageId)) continue
    // The tasks of a project whose deletion is refused stay.
    if (h.kind === 'tasks' && !h.mine && h.base && refused.projects.has((h.base as Task).projectId)) continue
    if (!h.mine || !h.base) {
      out.push(h)
      continue
    }
    let mine = h.mine
    if (h.kind === 'pages') {
      const base = h.base as Page
      const m = mine as Page
      if (m.location.kind === 'inbox' && m.trashedAt && [...refused.projects].some((id) => inProject(base, id))) {
        mine = { ...m, location: base.location, trashedAt: base.trashedAt }
      }
      if (base.copiedFrom?.pageId && refused.pages.has(base.copiedFrom.pageId) && (mine as Page).copiedFrom?.pageId === null) {
        mine = { ...(mine as Page), copiedFrom: base.copiedFrom }
      }
    }
    mine = restoreIds(mine, h.base, 'categoryIds', refused.categories)
    mine = restoreIds(mine, h.base, 'tagIds', refused.tags)
    mine = restoreIds(mine, h.base, 'pinnedPageIds', refused.pages)
    mine = restoreIds(mine, h.base, 'hiddenPageIds', refused.pages)
    mine = restoreIds(mine, h.base, 'linkedPageIds', refused.pages)
    if (h.kind === 'templates') mine = restoreTemplateRefs(mine as Template, h.base as Template, refused)
    out.push(mine === h.mine ? h : { ...h, mine })
  }
  return out
}

/** Put back template references this window removed only because of a refused deletion. */
function restoreTemplateRefs(mine: Template, base: Template, refused: { pages: Set<string>; categories: Set<string>; tags: Set<string> }): Template {
  const back = (b: string[] | undefined, m: string[], set: Set<string>) => {
    const missing = (b ?? []).filter((id) => set.has(id) && !m.includes(id))
    return missing.length ? [...m, ...missing] : m
  }
  let changed = false
  const track = <T,>(before: T, after: T) => {
    if (before !== after) changed = true
    return after
  }
  const notes = mine.notes.map((n, i) => {
    const bn = base.notes[i]
    if (!bn) return n
    const categoryIds = track(n.categoryIds, back(bn.categoryIds, n.categoryIds, refused.categories))
    const tagIds = track(n.tagIds, back(bn.tagIds, n.tagIds, refused.tags))
    return categoryIds === n.categoryIds && tagIds === n.tagIds ? n : { ...n, categoryIds, tagIds }
  })
  const project =
    mine.project && base.project
      ? {
          ...mine.project,
          categoryIds: track(mine.project.categoryIds, back(base.project.categoryIds, mine.project.categoryIds, refused.categories)),
          pinnedPageIds: track(mine.project.pinnedPageIds, back(base.project.pinnedPageIds, mine.project.pinnedPageIds, refused.pages)),
        }
      : mine.project
  const tasks = mine.tasks.map((t, i) => {
    const pageIds = track(t.pageIds, back(base.tasks[i]?.pageIds, t.pageIds, refused.pages))
    return pageIds === t.pageIds ? t : { ...t, pageIds }
  })
  return changed ? { ...mine, notes, project, tasks } : mine
}

export function reconcileHeldChanges(heldChanges: HeldChange[], latest: LatestRecords, now: string): ReconcileResult {
  const held = withoutRefusedCascades(heldChanges, latest)
  const changes = emptyChangeSet()
  const recovered: RecoveredItem[] = []
  let applied = 0
  let unchanged = 0
  // Working view of the workspace after the writes decided so far.
  const view = {
    projects: { ...latest.projects },
    tasks: { ...latest.tasks },
    templates: { ...latest.templates },
    categories: { ...latest.categories },
    tags: { ...latest.tags },
    notebooks: { ...latest.notebooks },
    sections: { ...latest.sections },
    pages: { ...latest.pages },
    objects: { ...latest.objects },
  }
  const put = (kind: RecordKind, rec: AnyRecord) => {
    ;(view[kind] as Record<string, AnyRecord>)[rec.id] = rec
    ;(changes[kind] as Map<string, AnyRecord | null>).set(rec.id, rec)
  }
  const remove = (kind: RecordKind, id: string) => {
    delete (view[kind] as Record<string, AnyRecord>)[id]
    ;(changes[kind] as Map<string, AnyRecord | null>).set(id, null)
  }
  const pageName = (pageId: string, fallback?: AnyRecord | null) =>
    view.pages[pageId]?.title ?? latest.pages[pageId]?.title ?? (fallback as Page | null)?.title ?? 'a deleted page'
  const sourceOf = (h: HeldChange): string => {
    const rec = (h.mine ?? h.base)!
    if (h.kind === 'objects') return `On page “${pageName((rec as CanvasObject).pageId)}”`
    const title = (rec as Notebook).title ?? (rec as Project).name
    const noun = { pages: 'Page', sections: 'Section', notebooks: 'Notebook', projects: 'Project', tasks: 'Task', templates: 'Template', categories: 'Category', tags: 'Tag' }[h.kind]
    return `${noun} “${title}”`
  }
  const recoverRecord = (h: HeldChange, reason: string) => {
    const rec = h.mine!
    if (h.kind === 'objects' && (rec as CanvasObject).type === 'text') {
      recovered.push({ type: 'text', source: sourceOf(h), reason, doc: (rec as TextObject).doc })
    } else if (h.kind === 'objects') {
      recovered.push({ type: 'image', source: sourceOf(h), reason, image: rec as ImageObject })
    } else {
      const fields = h.base
        ? Object.keys(FIELD_LABELS).filter((f) => !sameValue((h.base as never)[f], (rec as never)[f]) && f in (rec as object))
        : h.kind === 'tasks'
          ? ['title', 'description', 'priority', 'dueDate', 'linkedPageIds'].filter((f) => !sameValue((rec as never)[f], f === 'linkedPageIds' ? [] : f === 'priority' ? 'normal' : f === 'dueDate' ? null : ''))
          : ['title' in (rec as object) ? 'title' : 'name']
      const detail = fields.map((f) => `${FIELD_LABELS[f]}: ${fieldText(h.kind, f, (rec as never)[f], latest)}`).join('; ') || 'Details changed'
      recovered.push({ type: 'note', source: sourceOf(h), reason, detail })
    }
  }

  /** A record's parent exists in the current view (sections→notebook, pages→section, objects→page). */
  const parentOk = (kind: RecordKind, rec: AnyRecord): boolean => {
    if (kind === 'sections') return !!view.notebooks[(rec as Section).notebookId]
    if (kind === 'pages') {
      const loc = (rec as Page).location
      if (loc.kind === 'section') return !!view.sections[loc.sectionId]
      if (loc.kind === 'project') return !!view.projects[loc.projectId]
      return true
    }
    if (kind === 'objects') return !!view.pages[(rec as CanvasObject).pageId]
    if (kind === 'tasks') return !!view.projects[(rec as Task).projectId]
    return true
  }

  // Parents before children; deletions run in reverse (tasks before their project).
  const order: RecordKind[] = ['categories', 'tags', 'projects', 'tasks', 'templates', 'notebooks', 'sections', 'pages', 'objects']
  const ofKind = (k: RecordKind) => held.filter((h) => h.kind === k)

  // 1) Creations and updates, parents first.
  for (const kind of order) {
    for (const h of ofKind(kind)) {
      if (!h.mine) continue
      const theirs = (latest[kind] as Record<string, AnyRecord>)[h.id] ?? null
      if (!h.base) {
        // Created in this window while it could not save.
        if (theirs) {
          if (!sameValue(theirs, h.mine)) recoverRecord(h, 'A record with the same identity already exists; the stored one was kept.')
          else unchanged++
          continue
        }
        if (parentOk(kind, h.mine)) {
          put(kind, h.mine)
          applied++
        } else if (kind === 'pages') {
          // Its section was deleted elsewhere: keep the new page, but in the Inbox.
          put(kind, { ...(h.mine as Page), location: { kind: 'inbox' }, updatedAt: now })
          recovered.push({ type: 'note', source: sourceOf(h), reason: 'Its section was deleted in the other window.', detail: 'The page was created in the Inbox instead.' })
          applied++
        } else {
          recoverRecord(h, `It was added to ${kind === 'objects' ? 'a page' : kind === 'sections' ? 'a notebook' : kind === 'tasks' ? 'a project' : 'a parent'} that was deleted in the other window.`)
        }
        continue
      }
      if (!theirs) {
        // Changed here, deleted elsewhere: never resurrect it.
        if (isIntendedChange(h.base, h.mine)) recoverRecord(h, 'It was deleted in the other window, so it was not restored there.')
        else unchanged++
        continue
      }
      const derived = kind === 'objects' && (h.mine as CanvasObject).type === 'text' ? ['h'] : []
      const merge = mergeFields(h.base, h.mine, theirs, derived, now)
      let result = merge.result
      const conflicts = [...merge.conflicts]
      if (merge.changed && !parentOk(kind, result)) {
        // e.g. moved here into a section that was deleted elsewhere: keep the stored location.
        if (kind === 'pages') result = { ...(result as Page), location: (theirs as Page).location }
        if (kind === 'sections') result = { ...(result as Section), notebookId: (theirs as Section).notebookId }
        conflicts.push(kind === 'pages' ? 'location' : 'notebookId')
      }
      if (merge.changed && !sameValue(result, theirs)) {
        put(kind, result)
        applied++
      } else if (conflicts.length === 0) {
        unchanged++
      }
      if (conflicts.length > 0) {
        if (kind === 'objects' && conflicts.includes('doc')) {
          recovered.push({ type: 'text', source: sourceOf(h), reason: 'This text was also changed in the other window; that version was kept.', doc: (h.mine as TextObject).doc })
        } else {
          const detail = conflicts
            .map((f) => `${FIELD_LABELS[f] ?? f}: this window had ${fieldText(kind, f, (h.mine as never)[f], latest)}; kept ${fieldText(kind, f, (theirs as never)[f], latest)}`)
            .join('; ')
          recovered.push({ type: 'note', source: sourceOf(h), reason: 'Changed in both windows; the other window’s version was kept.', detail })
        }
      }
    }
  }

  // 2) Deletions, children first; only if nothing changed elsewhere since.
  for (const kind of [...order].reverse()) {
    for (const h of ofKind(kind)) {
      if (h.mine || !h.base) continue
      const theirs = (latest[kind] as Record<string, AnyRecord>)[h.id]
      if (!theirs || !(view[kind] as Record<string, AnyRecord>)[h.id]) {
        unchanged++
        continue
      }
      let blocked = isIntendedChange(h.base, theirs)
      if (!blocked && kind === 'pages') blocked = Object.values(view.objects).some((o) => o.pageId === h.id)
      if (!blocked && kind === 'sections') blocked = Object.values(view.pages).some((p) => p.location.kind === 'section' && p.location.sectionId === h.id && !p.trashedAt)
      if (!blocked && kind === 'notebooks') blocked = Object.values(view.sections).some((s) => s.notebookId === h.id)
      if (!blocked && kind === 'projects') {
        blocked = Object.values(view.pages).some((p) => p.location.kind === 'project' && p.location.projectId === h.id) || Object.values(view.tasks).some((t) => t.projectId === h.id)
      }
      if (blocked) {
        recovered.push({ type: 'note', source: sourceOf({ ...h, mine: null }), reason: 'It was deleted in this window but changed or still in use in the other window, so it was kept.', detail: 'Delete it again if it is no longer needed.' })
        continue
      }
      if (kind === 'sections') {
        // Same rule as deleting a section normally: its trashed pages move to the Inbox.
        for (const p of Object.values(view.pages)) {
          if (p.location.kind === 'section' && p.location.sectionId === h.id) put('pages', { ...p, location: { kind: 'inbox' }, updatedAt: now })
        }
      }
      remove(kind, h.id)
      applied++
    }
  }

  // 3) No link may point at a record that no longer exists (deleted in either window).
  const removedLinks = repairLinks(view, now, put)
  if (removedLinks > 0) {
    recovered.push({ type: 'note', source: 'Links', reason: `${removedLinks} link${removedLinks === 1 ? '' : 's'} pointed at a category, tag, or page deleted in the other window and ${removedLinks === 1 ? 'was' : 'were'} removed.`, detail: 'The linked records themselves were not changed.' })
  }

  const recoveryPageId = recovered.length > 0 ? addRecoveryPage(recovered, now, put) : null
  return { changes, applied, recovered, unchanged, recoveryPageId }
}

type View = { [K in RecordKind]: Record<string, AnyRecord> }

/** Drop category/tag/page IDs that point at missing records. Returns how many were removed. */
function repairLinks(view: View, now: string, put: (kind: RecordKind, rec: AnyRecord) => void): number {
  let removed = 0
  const keep = (ids: string[], table: Record<string, unknown>) => {
    const kept = ids.filter((id) => id in table)
    removed += ids.length - kept.length
    return kept
  }
  for (const kind of ['notebooks', 'sections', 'pages', 'projects'] as const) {
    for (const rec of Object.values(view[kind])) {
      const r = rec as unknown as Record<string, unknown>
      const next: Record<string, unknown> = { ...r }
      let changed = false
      const fix = (field: string, table: Record<string, unknown>) => {
        if (!Array.isArray(r[field])) return
        const kept = keep(r[field] as string[], table)
        if (kept.length !== (r[field] as string[]).length) {
          next[field] = kept
          changed = true
        }
      }
      fix('categoryIds', view.categories)
      if (kind === 'pages') {
        fix('tagIds', view.tags)
        const from = (r as unknown as Page).copiedFrom
        if (from?.pageId && !view.pages[from.pageId]) {
          next.copiedFrom = { ...from, pageId: null }
          changed = true
        }
      }
      if (kind === 'projects') {
        fix('pinnedPageIds', view.pages)
        fix('hiddenPageIds', view.pages)
      }
      if (changed) put(kind, { ...next, updatedAt: now } as unknown as AnyRecord)
    }
  }
  for (const rec of Object.values(view.tasks)) {
    const task = rec as Task
    const kept = keep(task.linkedPageIds, view.pages)
    if (kept.length !== task.linkedPageIds.length) put('tasks', { ...task, linkedPageIds: kept, updatedAt: now })
  }
  const refCount = (t: Template) => templatePageIds(t).length + (t.project?.categoryIds.length ?? 0) + t.notes.reduce((n, x) => n + x.categoryIds.length + x.tagIds.length, 0)
  for (const rec of Object.values(view.templates)) {
    const t = rec as Template
    const next = pruneTemplateRefs(t, { category: (id) => id in view.categories, tag: (id) => id in view.tags, page: (id) => id in view.pages })
    if (next !== t) {
      removed += refCount(t) - refCount(next)
      put('templates', { ...next, updatedAt: now })
    }
  }
  return removed
}

function textDoc(heading: string, lines: string[], body?: RichTextDoc): RichTextDoc {
  const content: RichTextNode[] = [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: heading }] }]
  for (const line of lines) content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] })
  if (body?.content?.length) content.push(...body.content)
  return { type: 'doc', content }
}

/** A separate Inbox page listing everything that could not be applied in place. */
function addRecoveryPage(items: RecoveredItem[], now: string, put: (kind: RecordKind, rec: AnyRecord) => void): string {
  const pageId = newId()
  const stamp = new Date(now).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  put('pages', { id: pageId, title: `Recovered changes · ${stamp}`, location: { kind: 'inbox' }, order: 0, width: PAGE_WIDTH, categoryIds: [], tagIds: [], copiedFrom: null, createdAt: now, updatedAt: now, trashedAt: null })
  const textW = 720
  let y = 48
  let z = 1
  const addText = (doc: RichTextDoc) => {
    const lines = Math.max(3, docToPlainText(doc).split('\n').length + 1)
    const h = lines * 28
    put('objects', { id: newId(), pageId, type: 'text', x: 48, y, w: textW, h, z: z++, doc, createdAt: now, updatedAt: now })
    y += h + 24
  }
  addText(
    textDoc('Changes kept aside', [
      'Another window edited Minty Notes while this window could not save. These changes conflicted with that work or belonged to something deleted there, so they were kept here instead of overwriting anything.',
    ]),
  )
  for (const item of items) {
    if (item.type === 'text') addText(textDoc(item.source, [item.reason], item.doc))
    else if (item.type === 'note') addText(textDoc(item.source, [item.reason, item.detail]))
    else {
      addText(textDoc(item.source, [item.reason]))
      const w = Math.min(item.image.w, PAGE_WIDTH - 96)
      const h = Math.round((item.image.h * w) / item.image.w)
      put('objects', { ...item.image, id: newId(), pageId, x: 48, y, w, h, z: z++, createdAt: now, updatedAt: now })
      y += h + 24
    }
  }
  return pageId
}
