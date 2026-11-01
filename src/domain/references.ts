import type { Category, Notebook, Page, Project, Section } from './types'

/**
 * Projects and reusable knowledge (pure rules, no storage).
 *
 * - A page has one owner: the Inbox, standalone notes, a notebook section, or a project.
 * - Pages outside projects form the reference library. A project links to
 *   library pages without copying them:
 *     suggested = library pages that share a system category with the project
 *                 (the page's own categories plus its section's and notebook's),
 *     pinned    = pages the user linked explicitly,
 *     hidden    = suggestions the user dismissed for this project.
 * - Linked pages are the original records, so an edit shows everywhere they are
 *   linked. A "project copy" is a separate page owned by the project.
 */

export interface LibraryData {
  projects: Record<string, Project>
  categories: Record<string, Category>
  notebooks: Record<string, Notebook>
  sections: Record<string, Section>
  pages: Record<string, Page>
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)]
}

/** Categories a page inherits from its section and notebook. */
export function inheritedCategoryIds(page: Page, data: Pick<LibraryData, 'sections' | 'notebooks' | 'categories'>): string[] {
  if (page.location.kind !== 'section') return []
  const section = data.sections[page.location.sectionId]
  if (!section) return []
  const notebook = data.notebooks[section.notebookId]
  return unique([...(notebook?.categoryIds ?? []), ...section.categoryIds]).filter((id) => data.categories[id])
}

/** A page's own categories plus inherited ones (only categories that exist). */
export function pageCategoryIds(page: Page, data: Pick<LibraryData, 'sections' | 'notebooks' | 'categories'>): string[] {
  return unique([...page.categoryIds.filter((id) => data.categories[id]), ...inheritedCategoryIds(page, data)])
}

export function ownerProjectId(page: Page): string | null {
  return page.location.kind === 'project' ? page.location.projectId : null
}

/** Library pages are every page not owned by a project. */
export function isLibraryPage(page: Page): boolean {
  return page.location.kind !== 'project'
}

/** Not trashed, and not inside a trashed or missing project. */
export function isPageVisible(page: Page, data: Pick<LibraryData, 'projects'>): boolean {
  if (page.trashedAt) return false
  const owner = ownerProjectId(page)
  if (!owner) return true
  const project = data.projects[owner]
  return !!project && !project.trashedAt
}

export function isProjectOpen(project: Project): boolean {
  return !project.trashedAt && !project.archivedAt
}

/** Categories the project and page share (the reason a page is suggested). */
export function sharedCategoryIds(project: Project, page: Page, data: LibraryData): string[] {
  const own = new Set(project.categoryIds)
  return pageCategoryIds(page, data).filter((id) => own.has(id))
}

export interface ProjectReferences {
  /** Pages linked explicitly (live). */
  pinned: Page[]
  /** Library pages suggested by shared categories (not pinned, not hidden). */
  suggested: Page[]
  /** Suggestions or pins hidden for this project (live pages only). */
  hidden: Page[]
  /** Pinned pages that are currently in the Trash (they come back if restored). */
  trashedPinned: Page[]
}

const byTitle = (a: Page, b: Page) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)

export function projectReferences(project: Project, data: LibraryData): ProjectReferences {
  const pinnedIds = new Set(project.pinnedPageIds)
  const hiddenIds = new Set(project.hiddenPageIds)
  const pinned: Page[] = []
  const trashedPinned: Page[] = []
  for (const id of project.pinnedPageIds) {
    const page = data.pages[id]
    if (!page || ownerProjectId(page) === project.id) continue
    if (isPageVisible(page, data)) pinned.push(page)
    else if (page.trashedAt) trashedPinned.push(page)
  }
  const suggested: Page[] = []
  const hidden: Page[] = []
  if (project.categoryIds.length > 0) {
    for (const page of Object.values(data.pages)) {
      if (!isLibraryPage(page) || page.trashedAt || pinnedIds.has(page.id)) continue
      if (sharedCategoryIds(project, page, data).length === 0) continue
      if (hiddenIds.has(page.id)) hidden.push(page)
      else suggested.push(page)
    }
  }
  for (const id of project.hiddenPageIds) {
    const page = data.pages[id]
    if (page && isPageVisible(page, data) && !hidden.includes(page) && !pinnedIds.has(id) && ownerProjectId(page) !== project.id) hidden.push(page)
  }
  return { pinned, suggested: suggested.sort(byTitle), hidden: hidden.sort(byTitle), trashedPinned }
}

/** Is this page shown as a linked reference in the project? */
export function isLinkedTo(project: Project, page: Page, data: LibraryData): boolean {
  if (ownerProjectId(page) === project.id || page.trashedAt) return false
  if (project.pinnedPageIds.includes(page.id)) return true
  return isLibraryPage(page) && !project.hiddenPageIds.includes(page.id) && sharedCategoryIds(project, page, data).length > 0
}

/** Projects (not trashed) that show this page as a linked reference. */
export function linkedProjects(page: Page, data: LibraryData): Project[] {
  return Object.values(data.projects)
    .filter((p) => !p.trashedAt && isLinkedTo(p, page, data))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Pages a project owns (its notes), live only. */
export function projectNotes(projectId: string, pages: Record<string, Page>): Page[] {
  return Object.values(pages)
    .filter((p) => !p.trashedAt && ownerProjectId(p) === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Remove IDs that no longer point at an existing record. Returns the same array when nothing changed. */
export function keepExisting(ids: string[], exists: (id: string) => boolean): string[] {
  const kept = ids.filter(exists)
  return kept.length === ids.length ? ids : kept
}
