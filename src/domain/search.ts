import { isLibraryPage, isLinkedTo, isPageVisible, ownerProjectId, pageCategoryIds, type LibraryData } from './references'
import type { AttachmentMeta, Page, Project, Tag, Task } from './types'

/**
 * Local search over project details, page titles and text, tags, categories,
 * task titles and details, and attachment names. Everything runs in memory on this device.
 */

export type SearchKind = 'project' | 'project-note' | 'reference' | 'note' | 'task' | 'attachment'

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  project: 'Project',
  'project-note': 'Project note',
  reference: 'Reference page',
  note: 'Note',
  task: 'Task',
  attachment: 'Attachment',
}

/** Searchable content of one page: plain text of its text boxes and its image attachments. */
export interface PageText {
  text: string
  attachmentIds: string[]
}

export interface SearchData extends LibraryData {
  tags: Record<string, Tag>
  /** Optional so callers without tasks (older tests) still work. */
  tasks?: Record<string, Task>
  attachments: Record<string, AttachmentMeta>
}

export interface SearchFilters {
  /** 'all', 'none' (items without a project), or a project ID (its notes, links, and the project itself). */
  project: string
  /** 'all' or a category ID. */
  category: string
  /** 'all' or a tag ID. */
  tag: string
  /** Kinds to include; empty means all. */
  kinds: SearchKind[]
  includeArchived: boolean
}

export const DEFAULT_FILTERS: SearchFilters = { project: 'all', category: 'all', tag: 'all', kinds: [], includeArchived: false }

export interface SearchResult {
  kind: SearchKind
  /** Project ID, page ID, task ID, or `attachmentId:pageId`. */
  key: string
  title: string
  /** Where it lives (project name, notebook › section, Inbox…). */
  context: string
  snippet: string
  pageId: string | null
  projectId: string | null
  /** Set for task results (open it on its project's board). */
  taskId?: string
  updatedAt: string
  score: number
}

export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function tokenize(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean)
}

interface Field {
  text: string
  weight: number
  /** Used for the result snippet. */
  snippet?: boolean
}

function scoreFields(tokens: string[], fields: Field[]): { score: number; snippetField: Field | null } | null {
  let score = 0
  let snippetField: Field | null = null
  const normalized = fields.map((f) => normalize(f.text))
  for (const token of tokens) {
    let best = 0
    normalized.forEach((text, i) => {
      if (!text.includes(token)) return
      best = Math.max(best, fields[i].weight)
      if (!snippetField && fields[i].snippet) snippetField = fields[i]
    })
    if (best === 0) return null
    score += best
  }
  return { score, snippetField }
}

/** A short excerpt around the first matching token. */
export function makeSnippet(text: string, tokens: string[], radius = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const norm = normalize(flat)
  let at = -1
  for (const t of tokens) {
    const i = norm.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat
  const start = Math.max(0, at - radius)
  const end = Math.min(flat.length, at + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export function pageKind(page: Page): SearchKind {
  if (page.location.kind === 'project') return 'project-note'
  if (page.location.kind === 'section') return 'reference'
  return 'note'
}

export function pageContext(page: Page, data: Pick<LibraryData, 'projects' | 'sections' | 'notebooks'>): string {
  const loc = page.location
  if (loc.kind === 'project') return data.projects[loc.projectId]?.name ?? 'Project'
  if (loc.kind === 'section') {
    const s = data.sections[loc.sectionId]
    return s ? `${data.notebooks[s.notebookId]?.title ?? 'Notebook'} › ${s.title}` : 'Notebook'
  }
  return loc.kind === 'inbox' ? 'Inbox' : 'Standalone notes'
}

function projectFields(p: Project, data: SearchData): Field[] {
  const list = (items: { name?: string; label?: string; detail?: string; value?: string; role?: string; phone?: string; email?: string }[]) =>
    items.map((i) => [i.name, i.label, i.detail, i.value, i.role, i.phone, i.email].filter(Boolean).join(' ')).join(' · ')
  return [
    { text: p.name, weight: 3 },
    { text: [p.customer, p.site, p.jobNumber].join(' · '), weight: 2, snippet: true },
    { text: p.description, weight: 1, snippet: true },
    { text: `Contacts: ${list(p.contacts)}`, weight: 1, snippet: true },
    { text: `Equipment: ${list(p.equipment)}`, weight: 1, snippet: true },
    { text: `Software: ${list(p.software)}`, weight: 1, snippet: true },
    { text: `Files: ${list(p.fileLocations)}`, weight: 1, snippet: true },
    { text: p.categoryIds.map((id) => data.categories[id]?.name ?? '').join(' '), weight: 1 },
    { text: p.status, weight: 1 },
  ]
}

function projectAllowed(p: Project, f: SearchFilters): boolean {
  if (p.trashedAt) return false
  if (p.archivedAt && !f.includeArchived) return false
  return true
}

export function search(query: string, filters: SearchFilters, data: SearchData, texts: Map<string, PageText>): SearchResult[] {
  const tokens = tokenize(query)
  const hasFilter = filters.project !== 'all' || filters.category !== 'all' || filters.tag !== 'all' || filters.kinds.length > 0
  if (tokens.length === 0 && !hasFilter) return []
  const wants = (k: SearchKind) => filters.kinds.length === 0 || filters.kinds.includes(k)
  const results: SearchResult[] = []
  const filterProject = filters.project !== 'all' && filters.project !== 'none' ? data.projects[filters.project] : null

  // Projects
  if (wants('project') && filters.tag === 'all' && filters.project !== 'none') {
    for (const p of Object.values(data.projects)) {
      if (!projectAllowed(p, filters)) continue
      if (filterProject && p.id !== filterProject.id) continue
      if (filters.category !== 'all' && !p.categoryIds.includes(filters.category)) continue
      const fields = projectFields(p, data)
      const m = tokens.length ? scoreFields(tokens, fields) : { score: 0, snippetField: null }
      if (!m) continue
      const snippetText = m.snippetField?.text ?? [p.customer, p.site].filter(Boolean).join(' · ')
      results.push({ kind: 'project', key: p.id, title: p.name || 'Untitled project', context: p.archivedAt ? 'Archived project' : 'Project', snippet: makeSnippet(snippetText, tokens), pageId: null, projectId: p.id, updatedAt: p.updatedAt, score: m.score + 0.5 })
    }
  }

  // Tasks (in projects that are not in the Trash; archived ones only on request)
  if (wants('task') && filters.tag === 'all' && filters.project !== 'none' && tokens.length > 0) {
    for (const t of Object.values(data.tasks ?? {})) {
      const p = data.projects[t.projectId]
      if (!p || !projectAllowed(p, filters)) continue
      if (filterProject && p.id !== filterProject.id) continue
      if (filters.category !== 'all' && !p.categoryIds.includes(filters.category)) continue
      const m = scoreFields(tokens, [
        { text: t.title, weight: 3 },
        { text: t.description, weight: 1, snippet: true },
        { text: p.name, weight: 1 },
      ])
      if (!m) continue
      const status = { todo: 'To do', doing: 'Doing', done: 'Done' }[t.status]
      results.push({ kind: 'task', key: t.id, title: t.title || 'Untitled task', context: `${p.name || 'Untitled project'} · ${status}`, snippet: makeSnippet(t.description, tokens), pageId: null, projectId: p.id, taskId: t.id, updatedAt: t.updatedAt, score: m.score })
    }
  }

  // Pages, and attachments placed on them
  const pageAllowed = (page: Page): boolean => {
    if (!isPageVisible(page, data)) return false
    const owner = ownerProjectId(page)
    if (owner && data.projects[owner]?.archivedAt && !filters.includeArchived) return false
    if (filters.project === 'none' && owner) return false
    if (filterProject && owner !== filterProject.id && !isLinkedTo(filterProject, page, data)) return false
    if (filters.category !== 'all' && !pageCategoryIds(page, data).includes(filters.category)) return false
    if (filters.tag !== 'all' && !page.tagIds.includes(filters.tag)) return false
    return true
  }
  const seenAttachments = new Set<string>()
  for (const page of Object.values(data.pages)) {
    if (!pageAllowed(page)) continue
    const content = texts.get(page.id)
    const kind = pageKind(page)
    const context = pageContext(page, data)
    if (wants(kind)) {
      const fields: Field[] = [
        { text: page.title, weight: 3 },
        { text: page.tagIds.map((id) => data.tags[id]?.name ?? '').join(' '), weight: 2 },
        { text: pageCategoryIds(page, data).map((id) => data.categories[id]?.name ?? '').join(' '), weight: 1 },
        { text: content?.text ?? '', weight: 1, snippet: true },
        { text: context, weight: 1 },
      ]
      const m = tokens.length ? scoreFields(tokens, fields) : { score: 0, snippetField: null }
      if (m) {
        const linked = isLibraryPage(page) && kind !== 'note' ? 'Reference library · ' : ''
        results.push({ kind, key: page.id, title: page.title || 'Untitled', context: `${linked}${context}`, snippet: makeSnippet(content?.text ?? '', tokens), pageId: page.id, projectId: ownerProjectId(page), updatedAt: page.updatedAt, score: m.score })
      }
    }
    if (wants('attachment') && content) {
      for (const id of content.attachmentIds) {
        const meta = data.attachments[id]
        if (!meta || seenAttachments.has(id)) continue
        const m = tokens.length ? scoreFields(tokens, [{ text: meta.fileName, weight: 2 }, { text: page.title, weight: 1 }]) : { score: 0, snippetField: null }
        if (!m) continue
        seenAttachments.add(id)
        results.push({ kind: 'attachment', key: `${id}:${page.id}`, title: meta.fileName, context: `On “${page.title || 'Untitled'}” · ${context}`, snippet: '', pageId: page.id, projectId: ownerProjectId(page), updatedAt: meta.createdAt, score: m.score })
      }
    }
  }
  return results.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
}
