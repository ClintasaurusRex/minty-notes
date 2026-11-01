import { BackupService } from '../backup/backupService'
import { saveBytesAsDownload } from '../platform/download'
import { EditorLock } from '../platform/editorLock'
import { registerServiceWorker } from '../platform/serviceWorker'
import { requestPersistentStorage } from '../platform/storageInfo'
import { IdbRepository } from '../storage/repository'
import { WorkspaceStore } from '../store/workspaceStore'
import { AttachmentUrls } from './attachmentUrls'

export interface Services {
  store: WorkspaceStore
  backup: BackupService
  lock: EditorLock
  attachments: AttachmentUrls
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

  let remoteReload: ReturnType<typeof setTimeout> | null = null
  const lock = new EditorLock({
    beforeRelease: async () => {
      await store.flush()
      store.setReadOnly(true)
      backup.stop()
    },
    afterAcquire: async () => {
      await store.load()
      store.setReadOnly(false)
      await backup.init()
      backup.start()
    },
    onRemoteSave: () => {
      // Read-only windows follow the editor window's saved data.
      if (remoteReload) clearTimeout(remoteReload)
      remoteReload = setTimeout(() => void store.load(), 300)
    },
  })

  const lockState = await lock.start()
  store.setReadOnly(lockState === 'read-only')
  await backup.init()
  if (lockState !== 'read-only') backup.start()

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
    onBlocked: (l) => {
      blockedListeners.add(l)
      return () => blockedListeners.delete(l)
    },
  }
}
