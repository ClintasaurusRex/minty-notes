/**
 * Backup-folder access through the File System Access API (Chrome/Edge).
 * Functions take the directory handle as a parameter so they can be tested
 * with simulated handles. Real permission prompts need a manual Chrome check.
 */

import { sha256Hex } from './archive'

export type FolderPermission = 'granted' | 'prompt' | 'denied'

/**
 * Snapshot names. Since 0.5.0 new snapshots use the computer's local date and
 * 24-hour time to the minute (`minty-notes-backup-20261115-1334.zip`); earlier
 * versions used UTC to the second (`minty-notes-backup-20261115-213400Z.zip`).
 * Both are recognised forever. A same-minute (or same-second) collision gets
 * `-2`, `-3`, … from `writeFolderFile`.
 */
const SNAPSHOT_PATTERN = /^minty-notes-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:(\d{2})Z)?(?:-(\d+))?\.zip$/
export const SNAPSHOT_PREFIX = 'minty-notes-backup-'
export const SAFEGUARD_PREFIX = 'minty-notes-before-restore-'

export function isFolderBackupSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
}

/** Local date and 24-hour time to the minute, e.g. `20261115-0800`. */
function localStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`
}

/** Name for a new backup snapshot (folder or download): local time, no seconds. */
export function snapshotFileName(date = new Date()): string {
  return `${SNAPSHOT_PREFIX}${localStamp(date)}.zip`
}

/** Name for the before-restore safety copy (unchanged UTC format; never pruned). */
export function safeguardFileName(date = new Date()): string {
  return `${SAFEGUARD_PREFIX}${stamp(date)}.zip`
}

/** True for every snapshot name this or an earlier version could have written. */
export function isSnapshotName(name: string): boolean {
  return SNAPSHOT_PATTERN.test(name)
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** The range of real moments (UTC ms, inclusive) a snapshot name can stand for. */
export interface SnapshotTime {
  earliest: number
  latest: number
  /** Collision suffix (`-2` → 2); 1 for none. Not a reliable order: a freed lower number can be reused. */
  suffix: number
}

/**
 * Parse a snapshot name into the moments it can represent, or null if it is not
 * a snapshot name or names an impossible date (such a file is listed but never
 * pruned). Old UTC names are exact to the second. Local names are
 * read with the computer's current time-zone rules: a time repeated when
 * daylight saving ends covers both moments, and a time that does not exist
 * locally (skipped hour, or written in another zone) covers every offset seen
 * around it. `offsetAt` (minutes, as `Date#getTimezoneOffset`) is injectable for tests.
 */
export function snapshotTime(name: string, offsetAt: (ms: number) => number = (ms) => new Date(ms).getTimezoneOffset()): SnapshotTime | null {
  const m = SNAPSHOT_PATTERN.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number)
  const utcSeconds = m[6] === undefined ? null : Number(m[6])
  const suffix = m[7] === undefined ? 1 : Number(m[7])
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || (utcSeconds ?? 0) > 59) return null
  const wall = Date.UTC(y, mo - 1, d, h, mi, utcSeconds ?? 0)
  if (new Date(wall).getUTCDate() !== d) return null // e.g. 20260231
  if (utcSeconds !== null) return { earliest: wall, latest: wall + 999, suffix }
  // Local wall time: the real moment is wall + offset for whichever offset applied.
  // Zone offsets stay within ±14 h and change at most once in two days.
  const offsets = [...new Set([wall - DAY, wall, wall + DAY].map(offsetAt))]
  const exact = offsets.map((off) => wall + off * MINUTE).filter((t) => t - offsetAt(t) * MINUTE === wall)
  const moments = exact.length > 0 ? exact : offsets.map((off) => wall + off * MINUTE)
  return { earliest: Math.min(...moments), latest: Math.max(...moments) + MINUTE - 1, suffix }
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

async function existingNames(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const existing = new Set<string>()
  for await (const key of dir.keys()) existing.add(key)
  return existing
}

function candidateName(name: string, n: number): string {
  return n === 1 ? name : `${name.replace(/\.zip$/, '')}-${n}.zip`
}

/** A write that failed after its output file was created; `fileName` may remain in the folder. */
export class FolderWriteError extends Error {
  readonly fileName: string
  constructor(fileName: string, cause: unknown) {
    super(cause instanceof Error && cause.message ? cause.message : 'The backup could not be written to the folder.', { cause })
    // Keep the browser's error name so `describeFolderError` explains it (disk full, permission…).
    this.name = cause instanceof Error ? cause.name : 'Error'
    this.fileName = fileName
  }
}

export interface WrittenFile {
  fileName: string
  size: number
  sha256: string
}

const MAX_NAME_ATTEMPTS = 50

/**
 * Write a new file and verify it byte for byte; returns the name used and the
 * SHA-256 of the verified contents.
 *
 * Names: `name`, else `-2`, `-3`… The File System Access API has no exclusive
 * create, so a name free when the folder was listed may be taken before the
 * file is opened. After opening, the file must still be empty; if it is not,
 * another program has written there and the next name is tried. A file created
 * by someone else in the short moment between that check and our close could
 * still be replaced (a platform limit; see DATA_FORMAT.md).
 *
 * Failure never deletes anything: Minty Notes cannot prove that the file at
 * that name is its own output, so it is left in place and reported through
 * `FolderWriteError.fileName`. It is never counted or removed by retention.
 * The browser writes into a temporary file and replaces the target only on
 * close, so an interrupted write leaves at most an empty file.
 */
export async function writeFolderFile(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<WrittenFile> {
  const expected = await sha256Hex(bytes)
  const existing = await existingNames(dir)
  let n = 1
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    while (existing.has(candidateName(name, n))) n++
    const fileName = candidateName(name, n)
    existing.add(fileName)
    const handle = await dir.getFileHandle(fileName, { create: true })
    // Another program may have created this name since the listing: never write over its content.
    if ((await handle.getFile()).size !== 0) continue
    let writable: FileSystemWritableFileStream | null = null
    try {
      writable = await handle.createWritable()
      await writable.write(bytes as Uint8Array<ArrayBuffer>)
      await writable.close()
      writable = null
      const written = new Uint8Array(await (await handle.getFile()).arrayBuffer())
      if (written.byteLength !== bytes.byteLength) throw new Error(`The saved backup has the wrong size (${written.byteLength} of ${bytes.byteLength} bytes).`)
      if ((await sha256Hex(written)) !== expected) throw new Error('The saved backup does not match what was written (its contents differ).')
      return { fileName, size: bytes.byteLength, sha256: expected }
    } catch (err) {
      if (writable) await writable.abort().catch(() => undefined)
      throw new FolderWriteError(fileName, err)
    }
  }
  throw new Error('No free backup file name could be found in the folder.')
}

/** Snapshot names, oldest first by the time each name stands for (display only; never used to delete). */
export async function listSnapshots(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const found: { name: string; time: SnapshotTime }[] = []
  for await (const key of dir.keys()) {
    if (isSnapshotName(key)) found.push({ name: key, time: snapshotTime(key) ?? { earliest: -Infinity, latest: -Infinity, suffix: 1 } })
  }
  found.sort((a, b) => a.time.earliest - b.time.earliest || a.time.latest - b.time.latest || a.time.suffix - b.time.suffix || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return found.map((f) => f.name)
}

// ------------------------------------------------------------------ retention

/** One snapshot this browser wrote and verified (settings key `backupLedger`). */
export interface LedgerEntry {
  /** Order of recording, from one counter advanced under the editor-owner fence. Never a clock. */
  seq: number
  fileName: string
  size: number
  /** SHA-256 of the complete file, which passed `readArchive` before it was written. */
  sha256: string
  at: string
  revision: number
}

export interface BackupLedger {
  nextSeq: number
  entries: LedgerEntry[]
}

function normalizeLedger(raw: BackupLedger | undefined): BackupLedger {
  const entries = Array.isArray(raw?.entries)
    ? raw.entries.filter((e) => e && Number.isSafeInteger(e.seq) && typeof e.fileName === 'string' && Number.isSafeInteger(e.size) && typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256))
    : []
  const highest = entries.reduce((max, e) => Math.max(max, e.seq), 0)
  const nextSeq = Number.isSafeInteger(raw?.nextSeq) ? Math.max(raw!.nextSeq, highest + 1) : highest + 1
  return { nextSeq, entries }
}

/** Ledger update: record a newly verified snapshot (replacing any stale entry with the same name). */
export function recordInLedger(raw: BackupLedger | undefined, entry: Omit<LedgerEntry, 'seq'>): BackupLedger {
  const ledger = normalizeLedger(raw)
  return { nextSeq: ledger.nextSeq + 1, entries: [...ledger.entries.filter((e) => e.fileName !== entry.fileName), { ...entry, seq: ledger.nextSeq }] }
}

/** Ledger update: forget exactly these entries (removed files, or files no longer in the folder). */
export function forgetInLedger(raw: BackupLedger | undefined, drop: Pick<LedgerEntry, 'seq' | 'fileName'>[]): BackupLedger {
  const ledger = normalizeLedger(raw)
  return { nextSeq: ledger.nextSeq, entries: ledger.entries.filter((e) => !drop.some((d) => d.seq === e.seq && d.fileName === e.fileName)) }
}

export function ledgerEntries(raw: BackupLedger | undefined): LedgerEntry[] {
  return normalizeLedger(raw).entries
}

export interface RetentionReport {
  /** Snapshot-named files in the folder when retention started. */
  snapshotCount: number
  removed: string[]
  /** Recorded snapshots that were re-verified and counted towards `keep`. */
  verified: number
  /** Snapshot-named files this browser never recorded as written and verified. */
  unrecorded: string[]
  /** Recorded snapshots that are missing bytes, unreadable, or changed since they were written. */
  unverified: string[]
  /** Removals the folder refused. */
  removeFailed: string[]
  /** Cleanup stopped early: editing moved to another window, or a kept snapshot changed meanwhile. */
  stopped: boolean
  /** Ledger entries to forget: files removed now, or no longer present in this folder. */
  forget: Pick<LedgerEntry, 'seq' | 'fileName'>[]
}

type FileCheck = { ok: true; size: number; lastModified: number | undefined } | { ok: false }

/** Is the file at `entry.fileName` still exactly the verified snapshot that was recorded? */
async function checkEntry(dir: FileSystemDirectoryHandle, entry: LedgerEntry): Promise<FileCheck> {
  try {
    const file = await (await dir.getFileHandle(entry.fileName)).getFile()
    if (file.size !== entry.size) return { ok: false }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength !== entry.size || (await sha256Hex(bytes)) !== entry.sha256) return { ok: false }
    return { ok: true, size: file.size, lastModified: (file as Partial<File>).lastModified }
  } catch {
    return { ok: false }
  }
}

/** Cheap re-check that a kept replacement is still in place, just before a removal. */
async function unchanged(dir: FileSystemDirectoryHandle, name: string, seen: Extract<FileCheck, { ok: true }>): Promise<boolean> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile()
    return file.size === seen.size && (file as Partial<File>).lastModified === seen.lastModified
  } catch {
    return false
  }
}

/**
 * Remove old snapshots so that `keep` verified snapshots remain. Call only after
 * a successful, verified write; `protect` (that new file) is never removed.
 *
 * Neither file names nor modification times are trusted: clocks move, zones
 * change, and copies rewrite times. Order comes only from the ledger, whose
 * `seq` counter is advanced when a verified snapshot is recorded. A file is
 * removed only when all of these hold:
 *  - it is in the ledger and its bytes still match the recorded SHA-256
 *    (so it is the snapshot Minty Notes wrote: ownership);
 *  - at least `keep` snapshots with a higher `seq` are in the folder and their
 *    bytes match their recorded SHA-256 now (each passed the full archive check
 *    before it was written, so each is a complete, restorable backup);
 *  - those replacements are still unchanged just before the removal, and
 *    `canRemove` (editor ownership) agrees.
 * Everything else is kept: files from older versions, copies, other browsers,
 * interrupted writes, damaged or changed files. The report says what was kept
 * and why, so the caller can warn that the folder holds more than `keep`.
 */
export async function pruneSnapshots(
  dir: FileSystemDirectoryHandle,
  keep: number,
  ledger: LedgerEntry[],
  protect: string,
  canRemove: () => boolean | Promise<boolean> = () => true,
): Promise<RetentionReport> {
  const names = new Set<string>()
  for await (const key of dir.keys()) if (isSnapshotName(key)) names.add(key)
  const present = ledger.filter((e) => names.has(e.fileName)).sort((a, b) => b.seq - a.seq)
  const report: RetentionReport = {
    snapshotCount: names.size,
    removed: [],
    verified: 0,
    unrecorded: [...names].filter((n) => !present.some((e) => e.fileName === n)).sort(),
    unverified: [],
    removeFailed: [],
    stopped: false,
    forget: ledger.filter((e) => !names.has(e.fileName)).map(({ seq, fileName }) => ({ seq, fileName })),
  }
  if (names.size <= keep) return report

  // Newest first: count verified snapshots until `keep` of them are found.
  const kept: { entry: LedgerEntry; seen: Extract<FileCheck, { ok: true }> }[] = []
  let i = 0
  for (; i < present.length && kept.length < keep; i++) {
    const check = await checkEntry(dir, present[i])
    if (check.ok) kept.push({ entry: present[i], seen: check })
    else report.unverified.push(present[i].fileName)
  }
  report.verified = kept.length
  if (kept.length < keep) return report

  // Every remaining recorded snapshot is older (lower seq) than `keep` verified ones.
  const candidates = present.slice(i).filter((e) => e.fileName !== protect).reverse()
  for (const entry of candidates) {
    if (!(await canRemove())) {
      report.stopped = true
      break
    }
    const intact = await Promise.all(kept.map((k) => unchanged(dir, k.entry.fileName, k.seen)))
    if (!intact.every(Boolean)) {
      report.stopped = true
      break
    }
    // Ownership: only the exact bytes Minty Notes recorded are ever removed.
    if (!(await checkEntry(dir, entry)).ok) {
      report.unverified.push(entry.fileName)
      continue
    }
    if (!(await canRemove())) {
      report.stopped = true
      break
    }
    try {
      await dir.removeEntry(entry.fileName)
      report.removed.push(entry.fileName)
      report.forget.push({ seq: entry.seq, fileName: entry.fileName })
    } catch {
      report.removeFailed.push(entry.fileName)
    }
  }
  // After a stop, candidates not reached are simply kept for a later cleanup.
  return report
}

/**
 * Plain-language warning when the folder holds more than `keep` snapshots after
 * cleanup, or null. Nothing here deletes: it tells the user what to check.
 */
export function describeRetention(report: RetentionReport, keep: number): string | null {
  const remaining = report.snapshotCount - report.removed.length
  if (remaining <= keep) return null
  const reasons: string[] = []
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (report.unrecorded.length) reasons.push(`${count(report.unrecorded.length, 'was', 'were')} not written and verified by Minty Notes in this browser (for example backups from a version before 0.5.0, copied files, backups from another browser or computer, or a file left by an interrupted backup)`)
  if (report.unverified.length) reasons.push(`${count(report.unverified.length, 'has', 'have')} changed or become unreadable since being written`)
  if (report.verified < keep && !report.stopped) reasons.push(`only ${report.verified} verified backups written by Minty Notes in this browser are in the folder, fewer than ${keep}, so nothing older can be replaced yet`)
  if (report.removeFailed.length) reasons.push(`${count(report.removeFailed.length, 'could', 'could')} not be deleted because the folder refused`)
  if (report.stopped) reasons.push('cleanup stopped because the folder or the editing window changed while it ran')
  return `The backup folder holds ${remaining} snapshots, more than the ${keep} Minty Notes keeps. Some were left in place because Minty Notes could not prove they are safe to delete: ${reasons.join('; ')}. Your new backup was saved and verified. Look in the backup folder and delete snapshots you no longer need yourself; Minty Notes never deletes a backup it cannot verify.`
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
