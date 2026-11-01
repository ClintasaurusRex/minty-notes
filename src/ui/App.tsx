import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAppUpdate, useBackupState, useLockState, useServices, useWorkspace } from '../app/context'
import { applyUpdate } from '../platform/serviceWorker'
import { ReadOnlyError } from '../store/workspaceStore'
import { PageView } from './canvas/PageView'
import { relativeTime } from './format'
import { IconAlert, IconCheck, IconInbox, IconLeaf, IconNote, IconNotebook, IconPanel, IconQuick, IconSettings, IconTrash } from './icons'
import { Navigator, type NavSection } from './Navigator'
import { dismissNotice, noticeStore, notify } from './notices'
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

const RAIL: { id: NavSection; label: string; Icon: typeof IconInbox }[] = [
  { id: 'inbox', label: 'Inbox', Icon: IconInbox },
  { id: 'notes', label: 'Notes', Icon: IconNote },
  { id: 'notebooks', label: 'Notebooks', Icon: IconNotebook },
  { id: 'trash', label: 'Trash', Icon: IconTrash },
]

function SaveStatus() {
  const { store } = useServices()
  const save = useWorkspace((s) => s.save)
  const readOnly = useWorkspace((s) => s.readOnly)
  if (readOnly) return <span className="pill pill-muted">Read-only</span>
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

function Banners({ onSettings }: { onSettings: () => void }) {
  const { lock, backup, store } = useServices()
  const lockState = useLockState()
  const backupState = useBackupState()
  const update = useAppUpdate()
  const save = useWorkspace((s) => s.save)
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
      {lockState === 'read-only' && (
        <div className="banner" role="status" data-testid="readonly-banner">
          Minty Notes is being edited in another window, so this window is read-only.
          <button type="button" className="btn btn-small btn-primary" onClick={() => void lock.takeOver()}>
            Edit here instead
          </button>
        </div>
      )}
      {save.status === 'error' && (
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
      {lockState === 'editor' && (backupState.folderState === 'prompt' || backupState.folderState === 'denied') && (
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
  const epoch = useWorkspace((s) => s.epoch)
  const [section, setSection] = useState<NavSection>(() => (readPref('section') as NavSection | null) ?? 'inbox')
  const [pageId, setPageId] = useState<string | null>(() => readPref('page'))
  const [navOpen, setNavOpen] = useState(true)

  const openPage = (id: string) => {
    setPageId(id)
    writePref('page', id)
    if (section === 'settings' || section === 'trash') {
      setSection('inbox')
      writePref('section', 'inbox')
    }
  }
  const go = (s: NavSection) => {
    setSection(s)
    writePref('section', s)
  }

  const quickNote = () => {
    try {
      const page = store.createPage({ kind: 'inbox' })
      go('inbox')
      setPageId(page.id)
      writePref('page', page.id)
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
  const showPage = section !== 'settings' && page && !page.trashedAt

  return (
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
          <button key={id} type="button" className={`rail-btn${section === id ? ' is-active' : ''}`} aria-current={section === id ? 'true' : undefined} onClick={() => go(id)}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
        <div className="rail-spacer" />
        <button type="button" className={`rail-btn${section === 'settings' ? ' is-active' : ''}`} aria-current={section === 'settings' ? 'true' : undefined} onClick={() => go('settings')}>
          <IconSettings />
          <span>Settings</span>
        </button>
      </nav>
      {navOpen && section !== 'settings' && <Navigator key={epoch} section={section} pageId={pageId} onOpenPage={openPage} onQuickNote={quickNote} />}
      <main className="main">
        <div className="topbar">
          {section !== 'settings' && (
            <button type="button" className="icon-btn" aria-label={navOpen ? 'Hide page list' : 'Show page list'} aria-pressed={navOpen} title={navOpen ? 'Hide page list' : 'Show page list'} onClick={() => setNavOpen((v) => !v)}>
              <IconPanel />
            </button>
          )}
          <div className="topbar-title">Minty Notes</div>
          <StatusCluster onSettings={() => go('settings')} />
        </div>
        <Banners onSettings={() => go('settings')} />
        <div className="content">
          {section === 'settings' ? (
            <SettingsView />
          ) : showPage ? (
            <PageView key={`${epoch}:${pageId}`} pageId={pageId!} onLeave={() => setPageId(null)} />
          ) : (
            <div className="empty-main">
              <IconLeaf size={40} />
              <h1>Capture something</h1>
              <p className="muted">Start a quick note — it goes to your Inbox, no project or notebook needed.</p>
              <button type="button" className="btn btn-primary" onClick={quickNote}>
                <IconQuick size={16} /> New quick note
              </button>
              <p className="muted small">Shortcut: Alt+N</p>
            </div>
          )}
        </div>
      </main>
      <Notices />
    </div>
  )
}
