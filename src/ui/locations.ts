import { useWorkspace } from '../app/context'
import type { PageLocation } from '../domain/types'
import type { WorkspaceData } from '../store/workspaceStore'

export function locationKey(loc: PageLocation): string {
  return loc.kind === 'section' ? `section:${loc.sectionId}` : loc.kind
}

export function parseLocationKey(key: string): PageLocation | null {
  if (key === 'inbox' || key === 'standalone') return { kind: key }
  if (key.startsWith('section:')) return { kind: 'section', sectionId: key.slice(8) }
  return null
}

export function locationLabel(loc: PageLocation, data: Pick<WorkspaceData, 'sections' | 'notebooks'>): string {
  if (loc.kind === 'inbox') return 'Inbox'
  if (loc.kind === 'standalone') return 'Standalone notes'
  const section = data.sections[loc.sectionId]
  const notebook = section ? data.notebooks[section.notebookId] : undefined
  return section ? `${notebook?.title ?? 'Notebook'} › ${section.title}` : 'Missing section'
}

export interface LocationGroup {
  label: string
  options: { key: string; label: string }[]
}

/** Destinations for moving a page: Inbox, standalone, then each notebook's sections. */
export function useLocationOptions(): LocationGroup[] {
  const notebooks = useWorkspace((s) => s.data.notebooks)
  const sections = useWorkspace((s) => s.data.sections)
  const groups: LocationGroup[] = [
    { label: '', options: [{ key: 'inbox', label: 'Inbox' }] },
    { label: '', options: [{ key: 'standalone', label: 'Standalone notes' }] },
  ]
  for (const nb of Object.values(notebooks).sort((a, b) => a.order - b.order)) {
    const secs = Object.values(sections)
      .filter((s) => s.notebookId === nb.id)
      .sort((a, b) => a.order - b.order)
    if (secs.length) groups.push({ label: nb.title, options: secs.map((s) => ({ key: `section:${s.id}`, label: s.title })) })
  }
  return groups
}
