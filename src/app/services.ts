import { BackupService } from '../backup/backupService'
import { saveBytesAsDownload } from '../platform/download'
import { EditorLock, type HandoverResult } from '../platform/editorLock'
import { registerServiceWorker } from '../platform/serviceWorker'
import { requestPersistentStorage } from '../platform/storageInfo'
import { IdbRepository } from '../storage/repository'
import type { ReconcileResult } from '../store/reconcile'
import { WorkspaceStore } from '../store/workspaceStore'
import { notify } from '../ui/notices'
import { AttachmentUrls } from './attachmentUrls'

export interface Services {
  store: WorkspaceStore
  backup: BackupService
  lock: EditorLock
  attachments: AttachmentUrls
  /** Become the editing window (asks another editor window to hand over first). */
  takeOverEditing: () => Promise<HandoverResult>
  /** Set when another window upgraded the database; this window must reload. */
  onBlocked: (listener: () => void) => () => void
}

export async function createServices(): Promise<Services> {
  const blockedListeners = new Set<() => void>()
  let repo: IdbRepository | null = null
  repo = await IdbRepository.open(undefined, {
    onBlocking: () => {
      repo?.close()
      for (const l of blockedListeners) l()
    },
  })
  const store = new WorkspaceStore(repo)
  await store.load()
  const attachments = new AttachmentUrls(store)

  const backup = new BackupService(store, {
    appVersion: __APP_VERSION__,
    download: (bytes, fileName) => saveBytesAsDownload(bytes, fileName),
    onRestored: () => {
      attachments.clear()
      // Read-only windows reload the restored workspace.
      lock.announceSave()
    },
  })

  const reportRecovery = (result: ReconcileResult | null) => {
    if (!result) return
    const kept = result.recovered.length
    if (kept > 0) {
      notify('info', `Saved this window's held changes where they did not conflict. ${kept} item${kept === 1 ? '' : 's'} that conflicted or belonged to something deleted ${kept === 1 ? 'was' : 'were'} put in “Recovered changes” in the Inbox.`, 15000)
    } else if (result.applied > 0) {
      notify('success', "Saved this window's held changes.")
    }
  }

  let remoteReload: ReturnType<typeof setTimeout> | null = null
  const lock = new EditorLock({
    beforeRelease: async () => {
      // Freezes edits and saves; refuses (and keeps editing) if saving fails.
      const result = await store.releaseOwnership()
      if (result.ok) backup.stop()
      return result
    },
    afterAcquire: async () => {
      // Claims storage ownership, reconciles any changes held here, then reloads.
      reportRecovery(await store.becomeEditor())
      await backup.init()
      backup.start()
    },
    onLost: () => {
      // Stolen by another window: stop writes, retries, and backups right away.
      store.revokeOwnership()
      backup.stop()
    },
    onRemoteSave: () => {
      // Read-only windows follow the editor window's saved data.
      if (remoteReload) clearTimeout(remoteReload)
      remoteReload = setTimeout(() => void store.load(), 300)
    },
    onRefused: (reason) => {
      notify('info', `Another window asked to edit. This window kept editing because its latest changes could not be saved yet (${reason}).`)
    },
  })

  const lockState = await lock.start()
  if (lockState === 'read-only') store.revokeOwnership()
  else await store.becomeEditor()
  await backup.init()
  if (lockState !== 'read-only') backup.start()

  // Storage can also revoke ownership (another window claimed it); stop backups then.
  store.subscribe(() => {
    if (!store.getState().owner) backup.stop()
  })

  const takeOverEditing = async (): Promise<HandoverResult> => {
    // Still holding the lock but storage ownership was lost: just reclaim it.
    if (lock.getState() === 'editor' && !store.getState().owner) {
      try {
        reportRecovery(await store.becomeEditor())
        backup.start()
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
    }
    return lock.takeOver()
  }

  let lastSavedAt = store.getState().save.lastSavedAt
  store.subscribe(() => {
    const saved = store.getState().save.lastSavedAt
    if (saved !== lastSavedAt) {
      lastSavedAt = saved
      lock.announceSave()
    }
  })

  // Save when the window is hidden or closed; warn if something is still unsaved.
  const flushSoon = () => void store.flush()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSoon()
    else void backup.refreshPermission().then(() => backup.tick())
  })
  window.addEventListener('pagehide', flushSoon)
  window.addEventListener('beforeunload', (event) => {
    if (store.hasUnsavedChanges) {
      flushSoon()
      event.preventDefault()
    }
  })

  void requestPersistentStorage()
  void registerServiceWorker()

  return {
    store,
    backup,
    lock,
    attachments,
    takeOverEditing,
    onBlocked: (l) => {
      blockedListeners.add(l)
      return () => blockedListeners.delete(l)
    },
  }
}
