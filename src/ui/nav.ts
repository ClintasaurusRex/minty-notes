import { createContext, useContext } from 'react'

export type NavSection = 'home' | 'inbox' | 'projects' | 'notebooks' | 'notes' | 'tasks' | 'search' | 'trash' | 'settings'

export type ProjectTab = 'overview' | 'tasks' | 'files'

export interface OpenProjectOptions {
  tab?: ProjectTab
  /** Open this task's editor on the board. */
  taskId?: string
}

export interface Nav {
  section: NavSection
  pageId: string | null
  projectId: string | null
  /** The tab shown when a project is open. */
  projectTab: ProjectTab
  go: (section: NavSection) => void
  /** Open a page. `projectId` opens it in that project's context (e.g. a linked reference). */
  openPage: (pageId: string, projectId?: string | null) => void
  openProject: (projectId: string | null, options?: OpenProjectOptions) => void
  quickNote: () => void
}

export const NavContext = createContext<Nav | null>(null)

export function useNav(): Nav {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('NavContext is missing')
  return nav
}
