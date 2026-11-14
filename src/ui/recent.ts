/**
 * Recently opened pages on this device (a UI convenience in localStorage,
 * like the last open page). Not part of backups.
 */
const KEY = 'minty:recent'
const MAX = 20

export interface RecentEntry {
  pageId: string
  /** Project the page was opened from (for linked references), if any. */
  projectId: string | null
  at: string
}

export function readRecent(): RecentEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? (raw as RecentEntry[]).filter((e) => e && typeof e.pageId === 'string') : []
  } catch {
    return []
  }
}

export function recordRecent(pageId: string, projectId: string | null): void {
  try {
    const next = [{ pageId, projectId, at: new Date().toISOString() }, ...readRecent().filter((e) => e.pageId !== pageId)].slice(0, MAX)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Optional convenience.
  }
}
