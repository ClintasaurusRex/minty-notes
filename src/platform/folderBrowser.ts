/**
 * Read-only, session-scoped browsing. Only directory names are enumerated;
 * file bytes, writable streams, and persistent storage are never used here.
 */
export const FOLDER_ENTRY_LIMIT = 1_000

export type FolderEntry =
  | { kind: 'file'; name: string }
  | { kind: 'directory'; name: string; handle: FileSystemDirectoryHandle }

export function supportsFolderBrowsing(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

export async function chooseReadOnlyFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsFolderBrowsing()) throw new Error('Folder browsing is unavailable in this browser. Saved paths and web links still work.')
  try {
    return await window.showDirectoryPicker!({ id: 'minty-notes-browse', mode: 'read' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

/** `renew` is only passed by the explicit Reconnect button's user gesture. */
export async function readFolderPermission(handle: FileSystemDirectoryHandle, renew = false): Promise<PermissionState> {
  // OPFS handles and older implementations need no permission API.
  if (!handle.queryPermission) return 'granted'
  const permission = await handle.queryPermission({ mode: 'read' })
  if (permission !== 'granted' && renew && handle.requestPermission) return handle.requestPermission({ mode: 'read' })
  return permission
}

/** One level only. Even a folder with millions of names has bounded UI work. */
export async function listReadOnlyFolder(handle: FileSystemDirectoryHandle): Promise<{ entries: FolderEntry[]; truncated: boolean }> {
  const entries: FolderEntry[] = []
  let truncated = false
  for await (const entry of handle.values()) {
    if (entries.length >= FOLDER_ENTRY_LIMIT) {
      truncated = true
      break
    }
    entries.push(entry.kind === 'directory'
      ? { kind: 'directory', name: entry.name, handle: entry as FileSystemDirectoryHandle }
      : { kind: 'file', name: entry.name })
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
  return { entries, truncated }
}

export function folderBrowseError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The browser no longer allows Minty Notes to read this folder. Reconnect folder browsing or choose the folder again.'
  if (name === 'NotFoundError') return 'This folder could not be found. It may have moved. Choose the folder again.'
  return 'This folder could not be listed. Reconnect or choose another folder.'
}
