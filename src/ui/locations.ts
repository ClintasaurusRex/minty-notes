import { useWorkspace } from '../app/context'
import type { PageLocation } from '../domain/types'
import type { WorkspaceData } from '../store/workspaceStore'

export function locationKey(loc: PageLocation): string {
  if (loc.kind === 'section') return `section:${loc.sectionId}`
  if (loc.kind === 'project') return `project:${loc.projectId}`
  return loc.kind
}

export function parseLocationKey(key: string): PageLocation | null {
  if (key === 'inbox' || key === 'standalone') return { kind: key }
  if (key.startsWith('section:')) return { kind: 'section', sectionId: key.slice(8) }
  if (key.startsWith('project:')) return { kind: 'project', projectId: key.slice(8) }
  return null
}

export function locationLabel(loc: PageLocation, data: Pick<WorkspaceData, 'sections' | 'notebooks' | 'projects'>): string {
  if (loc.kind === 'inbox') return 'Inbox'
  if (loc.kind === 'standalone') return 'Standalone notes'
  if (loc.kind === 'project') return `${data.projects[loc.projectId]?.name ?? 'Missing project'} › Notes`
  const section = data.sections[loc.sectionId]
  const notebook = section ? data.notebooks[section.notebookId] : undefined
  return section ? `${notebook?.title ?? 'Notebook'} › ${section.title}` : 'Missing section'
}

export interface LocationGroup {
  label: string
  options: { key: string; label: string }[]
}

/** Destinations for moving a page: Inbox, standalone, open projects, then each notebook's sections. */
export function useLocationOptions(current?: PageLocation): LocationGroup[] {
  const notebooks = useWorkspace((s) => s.data.notebooks)
  const sections = useWorkspace((s) => s.data.sections)
  const projects = useWorkspace((s) => s.data.projects)
  const groups: LocationGroup[] = [
    { label: '', options: [{ key: 'inbox', label: 'Inbox' }] },
    { label: '', options: [{ key: 'standalone', label: 'Standalone notes' }] },
  ]
  const openProjects = Object.values(projects)
    .filter((p) => (!p.trashedAt && !p.archivedAt) || (current?.kind === 'project' && current.projectId === p.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (openProjects.length) groups.push({ label: 'Projects', options: openProjects.map((p) => ({ key: `project:${p.id}`, label: p.name || 'Untitled project' })) })
  for (const nb of Object.values(notebooks).sort((a, b) => a.order - b.order)) {
    const secs = Object.values(sections)
      .filter((s) => s.notebookId === nb.id)
      .sort((a, b) => a.order - b.order)
    if (secs.length) groups.push({ label: nb.title, options: secs.map((s) => ({ key: `section:${s.id}`, label: s.title })) })
  }
  return groups
}
