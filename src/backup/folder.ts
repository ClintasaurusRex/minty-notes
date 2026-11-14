/**
 * Backup-folder access through the File System Access API (Chrome/Edge).
 * Functions take the directory handle as a parameter so they can be tested
 * with simulated handles. Real permission prompts need a manual Chrome check.
 */

export type FolderPermission = 'granted' | 'prompt' | 'denied'

const SNAPSHOT_PATTERN = /^minty-notes-backup-\d{8}-\d{6}Z(?:-\d+)?\.zip$/
export const SNAPSHOT_PREFIX = 'minty-notes-backup-'
export const SAFEGUARD_PREFIX = 'minty-notes-before-restore-'

export function isFolderBackupSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
}

export function snapshotFileName(date = new Date(), prefix = SNAPSHOT_PREFIX): string {
  return `${prefix}${stamp(date)}.zip`
}

export function isSnapshotName(name: string): boolean {
  return SNAPSHOT_PATTERN.test(name)
}

/** Ask the user to choose a folder. Resolves null if they cancel. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) throw new Error('This browser cannot save backups to a folder. Use “Download backup” instead.')
  try {
    return await window.showDirectoryPicker({ id: 'minty-notes-backups', mode: 'readwrite', startIn: 'documents' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
}

/** Current permission without prompting. */
export async function queryFolderPermission(dir: FileSystemDirectoryHandle): Promise<FolderPermission> {
  if (!dir.queryPermission) return 'granted'
  return (await dir.queryPermission({ mode: 'readwrite' })) as FolderPermission
}

/** Ask for permission (must run inside a user gesture). */
export async function requestFolderPermission(dir: FileSystemDirectoryHandle): Promise<FolderPermission> {
  const current = await queryFolderPermission(dir)
  if (current === 'granted' || !dir.requestPermission) return current
  return (await dir.requestPermission({ mode: 'readwrite' })) as FolderPermission
}

async function uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const existing = new Set<string>()
  for await (const key of dir.keys()) existing.add(key)
  if (!existing.has(name)) return name
  const base = name.replace(/\.zip$/, '')
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}.zip`
    if (!existing.has(candidate)) return candidate
  }
}

/**
 * Write a file and verify its size. The browser writes to a temporary file and
 * only replaces the target when closed, so an interrupted write never leaves a
 * partial snapshot under the final name. Returns the name actually used.
 */
export async function writeFolderFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<string> {
  const finalName = await uniqueName(dir, name)
  const handle = await dir.getFileHandle(finalName, { create: true })
  let writable: FileSystemWritableFileStream | null = null
  try {
    writable = await handle.createWritable()
    await writable.write(bytes as Uint8Array<ArrayBuffer>)
    await writable.close()
    writable = null
    const written = await handle.getFile()
    if (written.size !== bytes.byteLength) throw new Error(`The saved backup has the wrong size (${written.size} of ${bytes.byteLength} bytes).`)
    return finalName
  } catch (err) {
    if (writable) await writable.abort().catch(() => undefined)
    await dir.removeEntry(finalName).catch(() => undefined)
    throw err
  }
}

export async function listSnapshots(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = []
  for await (const key of dir.keys()) if (isSnapshotName(key)) names.push(key)
  return names.sort()
}

/** Remove the oldest snapshots beyond `keep`. Call only after a successful write. */
export async function pruneSnapshots(dir: FileSystemDirectoryHandle, keep: number, protect: string): Promise<string[]> {
  const names = await listSnapshots(dir)
  const removable = names.filter((n) => n !== protect)
  const excess = names.length - keep
  const toRemove = excess > 0 ? removable.slice(0, excess) : []
  const removed: string[] = []
  for (const name of toRemove) {
    try {
      await dir.removeEntry(name)
      removed.push(name)
    } catch {
      // Leaving an extra old snapshot is harmless.
    }
  }
  return removed
}

export async function readFolderFile(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array> {
  const handle = await dir.getFileHandle(name)
  const file = await handle.getFile()
  return new Uint8Array(await file.arrayBuffer())
}

/** Explain a folder error in plain terms. */
export function describeFolderError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Minty Notes no longer has permission to write to the backup folder. Reconnect the folder.'
  if (name === 'NotFoundError') return 'The backup folder could not be found. It may have been moved or deleted. Choose the folder again.'
  if (name === 'QuotaExceededError') return 'The disk is full, so the backup could not be written.'
  if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') return 'The backup folder is busy or read-only. Try again in a moment.'
  return err instanceof Error && err.message ? err.message : 'The backup could not be written to the folder.'
}
