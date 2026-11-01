import { describeStorageError, SETTINGS } from '../storage/repository'
import type { WorkspaceStore } from '../store/workspaceStore'
import { buildArchive, type ArchiveValidation } from './archive'
import {
  SAFEGUARD_PREFIX,
  describeFolderError,
  isFolderBackupSupported,
  listSnapshots,
  pickFolder,
  pruneSnapshots,
  queryFolderPermission,
  readFolderFile,
  requestFolderPermission,
  snapshotFileName,
  writeFolderFile,
} from './folder'

export type FolderState = 'unsupported' | 'none' | 'granted' | 'prompt' | 'denied' | 'missing'

export interface BackupStatusRecord {
  /** Last snapshot successfully written and verified in the backup folder. */
  lastBackup: { at: string; fileName: string } | null
  /** Last downloaded backup (the browser cannot confirm the file was kept). */
  lastDownloadAt: string | null
  lastError: { at: string; message: string } | null
}

interface FolderRecord {
  handle: FileSystemDirectoryHandle
  name: string
  selectedAt: string
}

interface SafeguardRecord {
  createdAt: string
  fileName: string
  size: number
  blob: Blob
  folderFileName: string | null
}

export interface BackupState {
  folderState: FolderState
  folderName: string | null
  status: BackupStatusRecord
  running: null | 'backup' | 'download' | 'restore'
  safeguard: Omit<SafeguardRecord, 'blob'> | null
}

export interface BackupServiceOptions {
  appVersion: string
  intervalMs?: number
  keep?: number
  /** Inject for tests; defaults to the File System Access API picker. */
  pickFolder?: () => Promise<FileSystemDirectoryHandle | null>
  folderSupported?: boolean
  /** Trigger a browser download of bytes. */
  download?: (bytes: Uint8Array, fileName: string) => void
  /** Called after a restore replaced the workspace. */
  onRestored?: () => void
  /**
   * Marks the moment the saved folder handle is read back from storage. If that
   * read ever takes the page down, the next start skips it (no crash loop).
   */
  crashGuard?: { isSet(): boolean; set(on: boolean): void }
}

const GUARD_KEY = 'minty:reading-backup-folder'

/** Per-tab marker in sessionStorage; it survives a reload of the same tab. */
export const sessionCrashGuard = {
  isSet(): boolean {
    try {
      return sessionStorage.getItem(GUARD_KEY) === '1'
    } catch {
      return false
    }
  },
  set(on: boolean): void {
    try {
      if (on) sessionStorage.setItem(GUARD_KEY, '1')
      else sessionStorage.removeItem(GUARD_KEY)
    } catch {
      // Without sessionStorage the guard is simply inactive.
    }
  },
}

export type BackupResult = { ok: true; fileName: string } | { ok: false; message: string }

const ERROR_RETRY_MS = 5 * 60 * 1000

/**
 * Coordinates folder snapshots, downloads, and restore.
 * Automatic snapshots run only while the app is open and only from the
 * window that holds the editor lock.
 */
export class BackupService {
  private state: BackupState
  private readonly listeners = new Set<() => void>()
  private readonly store: WorkspaceStore
  private readonly opts: Required<Omit<BackupServiceOptions, 'onRestored'>> & Pick<BackupServiceOptions, 'onRestored'>
  private folder: FolderRecord | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastErrorAt = 0

  constructor(store: WorkspaceStore, options: BackupServiceOptions) {
    this.store = store
    this.opts = {
      intervalMs: 30 * 60 * 1000,
      keep: 10,
      pickFolder,
      folderSupported: isFolderBackupSupported(),
      crashGuard: sessionCrashGuard,
      download: () => {
        throw new Error('Downloads are not available here.')
      },
      ...options,
    }
    this.state = {
      folderState: this.opts.folderSupported ? 'none' : 'unsupported',
      folderName: null,
      status: { lastBackup: null, lastDownloadAt: null, lastError: null },
      running: null,
      safeguard: null,
    }
  }

  getState = (): BackupState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<BackupState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  private get repo() {
    return this.store.repository
  }

  get keep(): number {
    return this.opts.keep
  }

  get intervalMs(): number {
    return this.opts.intervalMs
  }

  async init(): Promise<void> {
    const [status, safeguard] = await Promise.all([
      this.repo.getSetting<BackupStatusRecord>(SETTINGS.backupStatus),
      this.repo.getSetting<SafeguardRecord>(SETTINGS.safeguard),
    ])
    this.set({
      status: status ?? this.state.status,
      safeguard: safeguard ? { createdAt: safeguard.createdAt, fileName: safeguard.fileName, size: safeguard.size, folderFileName: safeguard.folderFileName } : null,
    })
    const folder = await this.readSavedFolder()
    this.folder = folder ?? null
    this.set({ folderName: folder?.name ?? null })
    await this.refreshPermission()
  }

  private async readSavedFolder(): Promise<FolderRecord | undefined> {
    const guard = this.opts.crashGuard
    if (guard.isSet()) {
      // The last attempt in this tab never finished: forget the handle.
      guard.set(false)
      await this.repo.deleteSetting(SETTINGS.backupFolder).catch(() => undefined)
      await this.recordError('The browser could not reopen the saved backup folder, so it was forgotten. Choose the backup folder again.')
      return undefined
    }
    guard.set(true)
    try {
      return await this.repo.getSetting<FolderRecord>(SETTINGS.backupFolder)
    } catch {
      return undefined
    } finally {
      guard.set(false)
    }
  }

  /** Re-check folder permission without prompting. */
  async refreshPermission(): Promise<void> {
    if (!this.opts.folderSupported) return this.set({ folderState: 'unsupported' })
    if (!this.folder) return this.set({ folderState: 'none' })
    try {
      this.set({ folderState: await queryFolderPermission(this.folder.handle) })
    } catch (err) {
      this.set({ folderState: 'missing' })
      await this.recordError(describeFolderError(err))
    }
  }

  private async saveStatus(status: BackupStatusRecord): Promise<void> {
    this.set({ status })
    try {
      await this.repo.setSetting(SETTINGS.backupStatus, status)
    } catch {
      // Status is informational; the in-memory value is still shown.
    }
  }

  private recordError(message: string): Promise<void> {
    this.lastErrorAt = Date.now()
    return this.saveStatus({ ...this.state.status, lastError: { at: new Date().toISOString(), message } })
  }

  /** Let the user choose a backup folder, then write a first snapshot. */
  async chooseFolder(): Promise<BackupResult | null> {
    const handle = await this.opts.pickFolder()
    if (!handle) return null
    const permission = await requestFolderPermission(handle)
    this.folder = { handle, name: handle.name, selectedAt: new Date().toISOString() }
    await this.repo.setSetting(SETTINGS.backupFolder, this.folder)
    this.set({ folderName: handle.name, folderState: permission })
    if (permission !== 'granted') {
      const message = 'Permission to write to that folder was not granted.'
      await this.recordError(message)
      return { ok: false, message }
    }
    return this.backupNow()
  }

  /** Renew access after the browser revoked it (requires a user gesture). */
  async reconnectFolder(): Promise<BackupResult | null> {
    if (!this.folder) return null
    try {
      const permission = await requestFolderPermission(this.folder.handle)
      this.set({ folderState: permission })
      if (permission !== 'granted') return { ok: false, message: 'Folder access was not granted.' }
      return this.isDue() ? this.backupNow() : { ok: true, fileName: '' }
    } catch (err) {
      this.set({ folderState: 'missing' })
      const message = describeFolderError(err)
      await this.recordError(message)
      return { ok: false, message }
    }
  }

  async forgetFolder(): Promise<void> {
    this.folder = null
    await this.repo.deleteSetting(SETTINGS.backupFolder)
    this.set({ folderName: null, folderState: this.opts.folderSupported ? 'none' : 'unsupported' })
  }

  /** Save pending edits, then build a complete archive from stored data. */
  async createArchive(): Promise<{ bytes: Uint8Array; at: string }> {
    const saved = await this.store.flush()
    if (!saved) throw new Error('Recent changes could not be saved, so a backup now would be incomplete. Resolve the save error and try again.')
    const at = new Date().toISOString()
    const { records, blobs } = await this.repo.readAll()
    return { bytes: await buildArchive(records, blobs, this.opts.appVersion), at }
  }

  /** Write a verified snapshot to the backup folder and prune old ones afterwards. */
  async backupNow(): Promise<BackupResult> {
    if (this.state.running) return { ok: false, message: 'Another backup task is already running.' }
    if (!this.folder) return { ok: false, message: 'No backup folder is selected.' }
    this.set({ running: 'backup' })
    try {
      const permission = await queryFolderPermission(this.folder.handle)
      this.set({ folderState: permission })
      if (permission !== 'granted') {
        const message = 'The backup folder needs your permission again. Use “Reconnect folder”.'
        await this.recordError(message)
        return { ok: false, message }
      }
      const { bytes, at } = await this.createArchive()
      const fileName = await writeFolderFile(this.folder.handle, snapshotFileName(new Date(at)), bytes)
      await pruneSnapshots(this.folder.handle, this.opts.keep, fileName)
      await this.saveStatus({ ...this.state.status, lastBackup: { at, fileName }, lastError: null })
      return { ok: true, fileName }
    } catch (err) {
      const message = err instanceof Error && err.message.startsWith('Recent changes') ? err.message : describeFolderError(err)
      if (err instanceof DOMException && err.name === 'NotFoundError') this.set({ folderState: 'missing' })
      if (err instanceof DOMException && err.name === 'NotAllowedError') this.set({ folderState: 'prompt' })
      await this.recordError(message)
      return { ok: false, message }
    } finally {
      this.set({ running: null })
    }
  }

  /** Download a complete backup (works in any browser, without folder access). */
  async downloadBackup(): Promise<BackupResult> {
    if (this.state.running) return { ok: false, message: 'Another backup task is already running.' }
    this.set({ running: 'download' })
    try {
      const { bytes, at } = await this.createArchive()
      const fileName = snapshotFileName(new Date(at))
      this.opts.download(bytes, fileName)
      await this.saveStatus({ ...this.state.status, lastDownloadAt: at })
      return { ok: true, fileName }
    } catch (err) {
      const message = err instanceof Error ? err.message : describeStorageError(err)
      await this.recordError(message)
      return { ok: false, message }
    } finally {
      this.set({ running: null })
    }
  }

  /** True when the folder is usable, changes exist since the last snapshot, and the interval has passed. */
  isDue(now = Date.now()): boolean {
    const change = this.store.getState().data.lastChangeAt
    const last = this.state.status.lastBackup?.at
    if (!change) return false
    if (last && Date.parse(change) <= Date.parse(last)) return false
    if (!last) return true
    return now - Date.parse(last) >= this.opts.intervalMs
  }

  /** Periodic check while the app is open. */
  async tick(now = Date.now()): Promise<void> {
    if (this.store.getState().readOnly || this.state.running) return
    if (this.state.folderState !== 'granted' || !this.isDue(now)) return
    if (now - this.lastErrorAt < ERROR_RETRY_MS) return
    await this.backupNow()
  }

  start(checkEveryMs = 60_000): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), checkEveryMs)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async listFolderSnapshots(): Promise<string[]> {
    if (!this.folder) return []
    const names = await listSnapshots(this.folder.handle)
    return names.reverse()
  }

  readFolderSnapshot(name: string): Promise<Uint8Array> {
    if (!this.folder) throw new Error('No backup folder is selected.')
    return readFolderFile(this.folder.handle, name)
  }

  /**
   * Replace the workspace with a validated backup. The current workspace is
   * saved first as a safeguard; if that fails, nothing is replaced.
   */
  async restore(validated: Extract<ArchiveValidation, { ok: true }>): Promise<void> {
    if (this.state.running) throw new Error('Another backup task is already running.')
    if (this.store.getState().readOnly) throw new Error('Restore is only available in the window that is editing.')
    this.set({ running: 'restore' })
    try {
      const { bytes, at } = await this.createArchive().catch((err: unknown) => {
        throw new Error(`The current workspace could not be saved as a safety copy, so nothing was restored. ${err instanceof Error ? err.message : ''}`, { cause: err })
      })
      const fileName = snapshotFileName(new Date(at), SAFEGUARD_PREFIX)
      let folderFileName: string | null = null
      if (this.folder && this.state.folderState === 'granted') {
        folderFileName = await writeFolderFile(this.folder.handle, fileName, bytes).catch(() => null)
      }
      const safeguard: SafeguardRecord = { createdAt: at, fileName, size: bytes.byteLength, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), folderFileName }
      try {
        await this.repo.setSetting(SETTINGS.safeguard, safeguard)
      } catch (err) {
        if (!folderFileName) {
          throw new Error(`A safety copy of the current workspace could not be stored (${describeStorageError(err)}). Nothing was restored. Download a backup first.`, { cause: err })
        }
      }
      this.set({ safeguard: { createdAt: at, fileName, size: safeguard.size, folderFileName } })

      await this.repo.replaceAll(validated.records, validated.blobs)
      await this.store.load()
      this.opts.onRestored?.()
    } finally {
      this.set({ running: null })
    }
  }

  async downloadSafeguard(): Promise<void> {
    const record = await this.repo.getSetting<SafeguardRecord>(SETTINGS.safeguard)
    if (!record) return
    this.opts.download(new Uint8Array(await record.blob.arrayBuffer()), record.fileName)
  }

  async discardSafeguard(): Promise<void> {
    await this.repo.deleteSetting(SETTINGS.safeguard)
    this.set({ safeguard: null })
  }
}
