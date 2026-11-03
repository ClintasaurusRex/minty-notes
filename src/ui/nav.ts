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
  /**
   * Follow an internal page link: opens the page (keeping the current project
   * when the page is linked there), offers to restore a page in the Trash, and
   * explains a page that was deleted forever. Remembers where it came from.
   */
  followPageLink: (pageId: string) => void
  /** The page a followed link came from (null after any other navigation). */
  back: { pageId: string; title: string } | null
  goBack: () => void
}

export const NavContext = createContext<Nav | null>(null)

export function useNav(): Nav {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('NavContext is missing')
  return nav
}
