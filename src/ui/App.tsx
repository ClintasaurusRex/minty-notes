import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAppUpdate, useBackupState, useLockState, useServices, useWorkspace } from '../app/context'
import { applyUpdate } from '../platform/serviceWorker'
import { ReadOnlyError } from '../store/workspaceStore'
import { PageView } from './canvas/PageView'
import { relativeTime } from './format'
import { HomeView } from './HomeView'
import { IconAlert, IconCheck, IconHome, IconInbox, IconLeaf, IconNote, IconNotebook, IconPanel, IconProject, IconQuick, IconSearch, IconSettings, IconTrash } from './icons'
import { NavContext, type Nav, type NavSection } from './nav'
import { Navigator } from './Navigator'
import { dismissNotice, noticeStore, notify } from './notices'
import { ProjectView } from './ProjectView'
import { recordRecent } from './recent'
import { SearchView } from './SearchView'
import { SettingsView } from './SettingsView'

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`minty:${key}`)
  } catch {
    return null
  }
}
function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`minty:${key}`)
    else localStorage.setItem(`minty:${key}`, value)
  } catch {
    // UI preferences are optional.
  }
}

function isNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches
}

const RAIL: { id: NavSection; label: string; Icon: typeof IconInbox }[] = [
  { id: 'home', label: 'Home', Icon: IconHome },
  { id: 'inbox', label: 'Inbox', Icon: IconInbox },
  { id: 'projects', label: 'Projects', Icon: IconProject },
  { id: 'notebooks', label: 'Notebooks', Icon: IconNotebook },
  { id: 'notes', label: 'Notes', Icon: IconNote },
  { id: 'search', label: 'Search', Icon: IconSearch },
  { id: 'trash', label: 'Trash', Icon: IconTrash },
]

/** Sections that show the page list beside the main area. */
const LIST_SECTIONS: NavSection[] = ['inbox', 'projects', 'notebooks', 'notes', 'trash']
const SECTIONS: NavSection[] = ['home', 'inbox', 'projects', 'notebooks', 'notes', 'search', 'trash', 'settings']

/** The list a page naturally belongs to. */
function homeSection(kind: string): NavSection {
  return kind === 'inbox' ? 'inbox' : kind === 'standalone' ? 'notes' : kind === 'project' ? 'projects' : 'notebooks'
}

function SaveStatus() {
  const { store } = useServices()
  const save = useWorkspace((s) => s.save)
  const readOnly = useWorkspace((s) => s.readOnly)
  const held = useWorkspace((s) => s.heldChanges)
  if (readOnly) {
    return (
      <span className={`pill ${held > 0 ? 'pill-error' : 'pill-muted'}`} data-testid="save-status" data-status="read-only">
        Read-only{held > 0 ? ` · ${held} unsaved` : ''}
      </span>
    )
  }
  if (save.status === 'error') {
    return (
      <button type="button" className="pill pill-error" title={save.error ?? ''} onClick={() => void store.retrySave()} data-testid="save-status" data-status="error">
        <IconAlert size={14} /> Not saved — retry
      </button>
    )
  }
  const text = save.status === 'saving' ? 'Saving…' : save.status === 'pending' ? 'Unsaved changes' : 'Saved'
  return (
    <span className={`pill ${save.status === 'saved' ? 'pill-ok' : 'pill-muted'}`} role="status" aria-live="polite" data-testid="save-status" data-status={save.status} title={save.lastSavedAt ? `Last saved ${new Date(save.lastSavedAt).toLocaleTimeString()}` : ''}>
      {save.status === 'saved' && <IconCheck size={14} />} {text}
    </span>
  )
}

function StatusCluster({ onSettings }: { onSettings: () => void }) {
  const backup = useBackupState()
  const update = useAppUpdate()
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  const last = backup.status.lastBackup?.at
  const backupText =
    backup.folderState === 'prompt' || backup.folderState === 'denied'
      ? 'Backups paused'
      : backup.folderState === 'missing'
        ? 'Backup folder missing'
        : last
          ? `Backed up ${relativeTime(last)}`
          : backup.folderState === 'none' || backup.folderState === 'unsupported'
            ? 'No backup folder'
            : 'Not backed up yet'
  const warn = backup.folderState === 'prompt' || backup.folderState === 'denied' || backup.folderState === 'missing'
  return (
    <div className="status-cluster">
      <SaveStatus />
      {update.supported && (
        <span className={`pill ${update.offlineReady ? 'pill-muted' : 'pill-muted'}`} data-testid="offline-pill" title={update.offlineReady ? 'All app files are stored for offline use.' : 'Preparing offline use…'}>
          <span className={`dot ${update.offlineReady ? 'dot-ok' : ''}`} /> {update.offlineReady ? 'Offline ready' : 'Preparing offline…'}
        </span>
      )}
      <button type="button" className={`pill ${warn ? 'pill-warn' : 'pill-muted'}`} onClick={onSettings} data-testid="backup-pill">
        {backupText}
      </button>
    </div>
  )
}

function Notices() {
  const notices = useSyncExternalStore(noticeStore.subscribe, noticeStore.getState)
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.kind}`} role={n.kind === 'error' ? 'alert' : 'status'}>
          <span>{n.text}</span>
          <button type="button" className="icon-btn small" aria-label="Dismiss" onClick={() => dismissNotice(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

/** Shown whenever this window may not write. Offers taking over, and handles held changes. */
function OwnershipBanner() {
  const { takeOverEditing, store } = useServices()
  const lockState = useLockState()
  const owner = useWorkspace((s) => s.owner)
  const held = useWorkspace((s) => s.heldChanges)
  const [busy, setBusy] = useState(false)
  if (owner) return null
  const waiting = busy || lockState === 'acquiring'
  const takeOver = async () => {
    setBusy(true)
    const result = await takeOverEditing()
    setBusy(false)
    if (!result.ok) notify('error', `Could not start editing here: ${result.reason}`)
  }
  if (held > 0) {
    return (
      <div className="banner banner-error" role="alert" data-testid="readonly-banner" data-held={held}>
        Another window took over editing before {held} change{held === 1 ? '' : 's'} in this window could be saved. {held === 1 ? 'It was' : 'They were'} not written, so the other window&apos;s work is safe.
        <button type="button" className="btn btn-small btn-primary" disabled={waiting} onClick={() => void takeOver()}>
          {waiting ? 'Asking the other window…' : 'Edit here and save them'}
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={waiting}
          onClick={() => {
            if (window.confirm('Discard the changes this window could not save? This cannot be undone.')) void store.discardHeldChanges()
          }}
        >
          Discard them
        </button>
      </div>
    )
  }
  return (
    <div className="banner" role="status" data-testid="readonly-banner">
      Minty Notes is being edited in another window, so this window is read-only.
      <button type="button" className="btn btn-small btn-primary" disabled={waiting} onClick={() => void takeOver()}>
        {waiting ? 'Asking the other window…' : 'Edit here instead'}
      </button>
    </div>
  )
}

function Banners({ onSettings }: { onSettings: () => void }) {
  const { backup, store } = useServices()
  const backupState = useBackupState()
  const update = useAppUpdate()
  const save = useWorkspace((s) => s.save)
  const owner = useWorkspace((s) => s.owner)
  const [blocked, setBlocked] = useState(false)
  const { onBlocked } = useServices()
  useEffect(() => onBlocked(() => setBlocked(true)), [onBlocked])

  return (
    <>
      {blocked && (
        <div className="banner banner-error" role="alert">
          A newer version of Minty Notes opened in another window and needs this one to reload.
          <button type="button" className="btn btn-small" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      <OwnershipBanner />
      {save.status === 'error' && owner && (
        <div className="banner banner-error" role="alert" data-testid="save-error-banner">
          Changes are not saved: {save.error} They are kept in this window and will be retried.
          <button type="button" className="btn btn-small" onClick={() => void store.retrySave()}>
            Retry now
          </button>
          <button type="button" className="btn btn-small" onClick={onSettings}>
            Download a backup
          </button>
        </div>
      )}
      {owner && (backupState.folderState === 'prompt' || backupState.folderState === 'denied') && (
        <div className="banner banner-warn" role="status" data-testid="reconnect-banner">
          Folder backups are paused: the browser needs your permission to use “{backupState.folderName}” again.
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() =>
              void backup.reconnectFolder().then((r) => {
                if (r && !r.ok) notify('error', r.message)
                else if (r) notify('success', 'Backup folder reconnected.')
              })
            }
          >
            Reconnect folder
          </button>
        </div>
      )}
      {update.updateReady && (
        <div className="banner" role="status">
          A new version of Minty Notes is ready.
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() =>
              void applyUpdate(() => store.flush()).then((ok) => {
                if (!ok) notify('error', 'Changes could not be saved, so the update was postponed.')
              })
            }
          >
            Save and update
          </button>
        </div>
      )}
    </>
  )
}

export function App() {
  const { store } = useServices()
  const phase = useWorkspace((s) => s.phase)
  const loadError = useWorkspace((s) => s.loadError)
  const pages = useWorkspace((s) => s.data.pages)
  const projects = useWorkspace((s) => s.data.projects)
  const epoch = useWorkspace((s) => s.epoch)
  const [section, setSection] = useState<NavSection>(() => {
    const saved = readPref('section') as NavSection | null
    return saved && SECTIONS.includes(saved) ? saved : 'home'
  })
  const [pageId, setPageId] = useState<string | null>(() => readPref('page'))
  const [projectId, setProjectId] = useState<string | null>(() => readPref('project'))
  const [navOpen, setNavOpen] = useState(() => !isNarrow())

  const setPage = (id: string | null) => {
    setPageId(id)
    writePref('page', id)
  }
  const setProject = (id: string | null) => {
    setProjectId(id)
    writePref('project', id)
  }
  const setSec = (s: NavSection) => {
    setSection(s)
    writePref('section', s)
  }

  /** Open a page; `context` opens it inside a project (for linked references). */
  const openPage = (id: string, context?: string | null) => {
    const page = store.getState().data.pages[id]
    if (!page) return
    const owner = page.location.kind === 'project' ? page.location.projectId : null
    const inProject = context ?? owner
    if (inProject) {
      setSec('projects')
      setProject(inProject)
    } else if (!LIST_SECTIONS.includes(section) || section === 'trash' || section === 'projects') {
      setSec(homeSection(page.location.kind))
    }
    setPage(id)
    recordRecent(id, inProject ?? null)
    if (isNarrow()) setNavOpen(false)
  }
  const openProject = (id: string | null) => {
    setSec('projects')
    setProject(id)
    setPage(null)
    if (isNarrow() && id) setNavOpen(false)
  }
  const go = (s: NavSection) => {
    if (s === 'projects' && section !== 'projects') setPage(null)
    setSec(s)
    // On a phone-sized screen the page list overlays the page; show it when switching lists.
    if (isNarrow() && LIST_SECTIONS.includes(s)) setNavOpen(true)
  }

  const quickNote = () => {
    try {
      const page = store.createPage({ kind: 'inbox' })
      setSec('inbox')
      if (isNarrow()) setNavOpen(false)
      setPage(page.id)
      recordRecent(page.id, null)
    } catch (err) {
      if (err instanceof ReadOnlyError) notify('info', err.message)
      else throw err
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        quickNote()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (phase === 'loading') return <div className="splash">Opening Minty Notes…</div>
  if (phase === 'failed') {
    return (
      <div className="splash error-text" role="alert">
        Minty Notes could not open its local database: {loadError}
      </div>
    )
  }

  const page = pageId ? pages[pageId] : undefined
  const project = projectId ? projects[projectId] : undefined
  const pageProject = section === 'projects' && project ? project.id : null
  const showPage = LIST_SECTIONS.includes(section) && section !== 'trash' && page && !page.trashedAt && (section !== 'projects' || !!pageProject)
  const listVisible = navOpen && LIST_SECTIONS.includes(section)
  const nav: Nav = { section, pageId, projectId: project?.id ?? null, go, openPage, openProject, quickNote }

  let main
  if (section === 'settings') main = <SettingsView />
  else if (section === 'home') main = <HomeView />
  else if (section === 'search') main = <SearchView />
  else if (showPage) main = <PageView key={`${epoch}:${pageId}`} pageId={pageId!} projectId={pageProject} onLeave={() => (pageProject ? openProject(pageProject) : setPage(null))} />
  else if (section === 'projects' && project) main = <ProjectView projectId={project.id} />
  else if (section === 'projects')
    main = (
      <div className="empty-main">
        <IconProject size={40} />
        <h1>Projects</h1>
        <p className="muted">Choose a project from the list, or create one. Project notes, linked references, details, and file locations live together.</p>
      </div>
    )
  else
    main = (
      <div className="empty-main">
        <IconLeaf size={40} />
        <h1>Capture something</h1>
        <p className="muted">Start a quick note — it goes to your Inbox, no project or notebook needed.</p>
        <button type="button" className="btn btn-primary" onClick={quickNote}>
          <IconQuick size={16} /> New quick note
        </button>
        <p className="muted small">Shortcut: Alt+N</p>
      </div>
    )

  return (
    <NavContext.Provider value={nav}>
      <div className="app">
        <nav className="rail" aria-label="Main">
          <div className="rail-logo" title="Minty Notes">
            <IconLeaf size={22} />
          </div>
          <button type="button" className="rail-btn rail-quick" onClick={quickNote} title="Quick note (Alt+N)" data-testid="quick-note">
            <IconQuick />
            <span>Quick note</span>
          </button>
          {RAIL.map(({ id, label, Icon }) => (
            <button key={id} type="button" className={`rail-btn${section === id ? ' is-active' : ''}`} aria-current={section === id ? 'true' : undefined} onClick={() => go(id)} data-testid={`rail-${id}`}>
              <Icon />
              <span>{label}</span>
            </button>
          ))}
          <div className="rail-spacer" />
          <button type="button" className={`rail-btn${section === 'settings' ? ' is-active' : ''}`} aria-current={section === 'settings' ? 'true' : undefined} onClick={() => go('settings')} data-testid="rail-settings">
            <IconSettings />
            <span>Settings</span>
          </button>
        </nav>
        {listVisible && (
          <Navigator key={epoch} section={section} pageId={showPage ? pageId : null} projectId={project?.id ?? null} onOpenPage={openPage} onOpenProject={openProject} onQuickNote={quickNote} />
        )}
        <main className="main">
          <div className="topbar">
            {LIST_SECTIONS.includes(section) && (
              <button type="button" className="icon-btn" aria-label={navOpen ? 'Hide page list' : 'Show page list'} aria-pressed={navOpen} title={navOpen ? 'Hide page list' : 'Show page list'} onClick={() => setNavOpen((v) => !v)}>
                <IconPanel />
              </button>
            )}
            <div className="topbar-title">Minty Notes</div>
            <StatusCluster onSettings={() => go('settings')} />
          </div>
          <Banners onSettings={() => go('settings')} />
          <div className="content">{main}</div>
        </main>
        <Notices />
      </div>
    </NavContext.Provider>
  )
}
