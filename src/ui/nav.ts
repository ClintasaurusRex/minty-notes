import { createContext, useContext } from 'react'

export type NavSection = 'home' | 'inbox' | 'projects' | 'notebooks' | 'notes' | 'search' | 'trash' | 'settings'

export interface Nav {
  section: NavSection
  pageId: string | null
  projectId: string | null
  go: (section: NavSection) => void
  /** Open a page. `projectId` opens it in that project's context (e.g. a linked reference). */
  openPage: (pageId: string, projectId?: string | null) => void
  openProject: (projectId: string | null) => void
  quickNote: () => void
}

export const NavContext = createContext<Nav | null>(null)

export function useNav(): Nav {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('NavContext is missing')
  return nav
}
