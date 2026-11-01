import {
  PAGE_WIDTH,
  newId,
  nowIso,
  type AttachmentMeta,
  type CanvasObject,
  type Notebook,
  type Page,
  type PageLocation,
  type RichTextDoc,
  type Section,
  type WorkspaceInfo,
  type WorkspaceRecords,
} from '../domain/types'
import { changeSetSize, describeStorageError, emptyChangeSet, type ChangeSet, type Repository } from '../storage/repository'
import { PageHistory, type HistoryEntry, type ObjectChange } from './history'

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error'

export interface SaveState {
  status: SaveStatus
  lastSavedAt: string | null
  error: string | null
}

export interface WorkspaceData {
  workspace: WorkspaceInfo | null
  notebooks: Record<string, Notebook>
  sections: Record<string, Section>
  pages: Record<string, Page>
  /** Canvas objects by page ID, for pages that have been opened. */
  objects: Record<string, Record<string, CanvasObject>>
  attachments: Record<string, AttachmentMeta>
  lastChangeAt: string | null
  /** Stored revision; increases with every committed change. */
  revision: number
}

export interface StoreState {
  phase: 'loading' | 'ready' | 'failed'
  loadError: string | null
  data: WorkspaceData
  save: SaveState
  readOnly: boolean
  /**
   * Unsaved changes this window kept after losing editing rights. They are never
   * written unless this window becomes the editor again (or they are discarded).
   */
  heldChanges: number
  /** This window holds write ownership (false in read-only windows and after losing it). */
  owner: boolean
  /** Increments whenever undo/redo availability may have changed. */
  historyVersion: number
  /** Increments each time the workspace is (re)loaded from storage. */
  epoch: number
}

export interface StoreOptions {
  debounceMs?: number
  maxWaitMs?: number
  retryDelaysMs?: number[]
}

function emptyData(): WorkspaceData {
  return { workspace: null, notebooks: {}, sections: {}, pages: {}, objects: {}, attachments: {}, lastChangeAt: null, revision: 0 }
}

function byId<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((i) => [i.id, i]))
}

const titleFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function quickNoteTitle(date = new Date()): string {
  return `Quick note · ${titleFormat.format(date)}`
}

export class ReadOnlyError extends Error {
  constructor() {
    super('This window is read-only because Minty Notes is being edited in another window.')
    this.name = 'ReadOnlyError'
  }
}

/**
 * In-memory working copy of the workspace with debounced, transactional
 * autosave to the repository and per-page undo/redo of canvas edits.
 */
export class WorkspaceStore {
  private state: StoreState
  private readonly listeners = new Set<() => void>()
  private readonly repo: Repository
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly retryDelaysMs: number[]

  private dirty: ChangeSet = emptyChangeSet()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  private inflight: Promise<void> | null = null
  /** The batch being written right now (shown on top of stored data until it lands). */
  private inflightBatch: ChangeSet | null = null
  /** Whether this window may write. Writes also carry `token`, which storage checks. */
  private owner = true
  private token: string | null = null

  private readonly histories = new Map<string, PageHistory>()
  private textSession: { pageId: string; id: string; before: CanvasObject } | null = null

  constructor(repo: Repository, options: StoreOptions = {}) {
    this.repo = repo
    this.debounceMs = options.debounceMs ?? 400
    this.maxWaitMs = options.maxWaitMs ?? 2000
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 3000, 10000, 30000]
    this.state = {
      phase: 'loading',
      loadError: null,
      data: emptyData(),
      save: { status: 'saved', lastSavedAt: null, error: null },
      readOnly: false,
      heldChanges: 0,
      owner: true,
      historyVersion: 0,
      epoch: 0,
    }
  }

  // ---------------------------------------------------------------- basics

  getState = (): StoreState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get repository(): Repository {
    return this.repo
  }

  private setState(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  private setData(patch: Partial<WorkspaceData>): void {
    this.setState({ data: { ...this.state.data, ...patch } })
  }

  private assertWritable(): void {
    if (this.state.readOnly) throw new ReadOnlyError()
  }

  async load(): Promise<void> {
    try {
      const index = await this.repo.loadIndex()
      this.histories.clear()
      this.textSession = null
      // Changes being written or still queued in this window stay visible on top of stored data.
      const overlay = <T extends { id: string }>(items: T[], pick: (c: ChangeSet) => Map<string, T | null>) => {
        const map = byId(items)
        for (const batch of this.pendingBatches()) {
          for (const [id, value] of pick(batch)) {
            if (value) map[id] = value
            else delete map[id]
          }
        }
        return map
      }
      this.setState({
        phase: 'ready',
        loadError: null,
        historyVersion: this.state.historyVersion + 1,
        epoch: this.state.epoch + 1,
        data: {
          workspace: index.workspace,
          notebooks: overlay(index.notebooks, (c) => c.notebooks),
          sections: overlay(index.sections, (c) => c.sections),
          pages: overlay(index.pages, (c) => c.pages),
          objects: {},
          attachments: byId(index.attachments),
          lastChangeAt: index.activity.lastChangeAt,
          revision: index.activity.revision,
        },
      })
    } catch (err) {
      this.setState({ phase: 'failed', loadError: describeStorageError(err) })
    }
  }

  setReadOnly(readOnly: boolean): void {
    if (readOnly) this.endTextSession()
    this.setState({ readOnly })
  }

  /** Unstored changes, oldest first: the batch being written, then the queue. */
  private pendingBatches(): ChangeSet[] {
    return this.inflightBatch ? [this.inflightBatch, this.dirty] : [this.dirty]
  }

  // ------------------------------------------------------------ ownership

  /** True while this window is allowed to write (it may still be frozen read-only). */
  get isOwner(): boolean {
    return this.owner
  }

  /**
   * Become the only writer: claim ownership in storage (older owners' writes are
   * refused from then on), reload the latest data, then save any changes this
   * window was holding.
   */
  async becomeEditor(): Promise<void> {
    const token = newId()
    await this.repo.claimOwnership(token)
    this.token = token
    this.owner = true
    this.retryCount = 0
    if (changeSetSize(this.dirty) > 0) {
      // Store held edits first, so the reload below already contains them.
      this.setState({ save: { ...this.state.save, status: 'pending', error: null } })
      await this.flush()
    }
    await this.load()
    this.setState({ readOnly: false, heldChanges: 0, owner: true })
  }

  /**
   * Hand editing to another window. Edits are frozen first, then everything is
   * saved. If saving fails, this window keeps editing and nothing is lost.
   */
  async releaseOwnership(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.owner) return { ok: true }
    const wasReadOnly = this.state.readOnly
    this.setReadOnly(true)
    const saved = await this.flush()
    if (!saved) {
      if (!wasReadOnly) this.setState({ readOnly: false })
      return { ok: false, reason: this.state.save.error ?? 'Recent changes could not be saved.' }
    }
    this.owner = false
    this.token = null
    this.clearTimers()
    this.setState({ owner: false })
    return { ok: true }
  }

  /**
   * Editing was taken away (lock stolen or storage refused our token). Stop all
   * writes and retries immediately; keep unsaved changes in memory only.
   */
  revokeOwnership(): void {
    this.owner = false
    this.token = null
    this.clearTimers()
    this.endTextSession()
    const held = changeSetSize(this.dirty)
    this.setState({
      readOnly: true,
      owner: false,
      heldChanges: held,
      save: held > 0 ? { ...this.state.save, status: 'error', error: 'Another window took over editing before these changes were saved.' } : this.state.save,
    })
  }

  /** Drop changes held after losing editing rights, and show the stored data. */
  async discardHeldChanges(): Promise<void> {
    if (this.owner) return
    this.dirty = emptyChangeSet()
    this.setState({ heldChanges: 0, save: { ...this.state.save, status: 'saved', error: null } })
    await this.load()
  }

  /** Replace every record (restore). Queued edits from before are dropped. */
  async replaceWorkspace(records: WorkspaceRecords, blobs: Map<string, Blob>): Promise<void> {
    this.assertWritable()
    try {
      await this.repo.replaceAll(records, blobs, this.token)
    } catch (err) {
      if (err instanceof Error && err.name === 'OwnershipError') this.revokeOwnership()
      throw err
    }
    this.clearTimers()
    this.dirty = emptyChangeSet()
    await this.load()
  }

  // ------------------------------------------------------------- autosave

  /** Unsaved or held changes exist (used for the close-window warning). */
  get hasUnsavedChanges(): boolean {
    return changeSetSize(this.dirty) > 0 || this.inflight !== null
  }

  private markDirty<K extends keyof ChangeSet>(store: K, id: string, value: ChangeSet[K] extends Map<string, infer V> ? V : never): void {
    ;(this.dirty[store] as Map<string, unknown>).set(id, value)
    if (this.state.save.status !== 'saving' && this.state.save.status !== 'error') {
      this.setState({ save: { ...this.state.save, status: 'pending' } })
    }
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (!this.owner) return
    if (this.retryTimer) return // a retry is already scheduled after a failure
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.runSave(), this.debounceMs)
    this.maxWaitTimer ??= setTimeout(() => void this.runSave(), this.maxWaitMs)
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.debounceTimer = this.maxWaitTimer = this.retryTimer = null
  }

  private async runSave(): Promise<void> {
    this.clearTimers()
    if (!this.owner) return
    if (this.inflight) {
      await this.inflight
      if (changeSetSize(this.dirty) > 0) return this.runSave()
      return
    }
    if (changeSetSize(this.dirty) === 0) {
      if (this.state.save.status !== 'error') this.setState({ save: { ...this.state.save, status: 'saved' } })
      return
    }
    const batch = this.dirty
    this.dirty = emptyChangeSet()
    this.inflightBatch = batch
    const at = nowIso()
    this.setState({ save: { ...this.state.save, status: 'saving' } })
    this.inflight = this.repo.commit(batch, at, this.token).then(
      (revision) => {
        this.inflight = null
        this.inflightBatch = null
        this.retryCount = 0
        const pending = changeSetSize(this.dirty) > 0
        this.setState({ save: { status: pending ? 'pending' : 'saved', lastSavedAt: at, error: null } })
        this.setData({ lastChangeAt: at, revision })
        if (!this.owner) this.setState({ heldChanges: changeSetSize(this.dirty) })
        else if (pending) this.scheduleSave()
      },
      (err: unknown) => {
        this.inflight = null
        this.inflightBatch = null
        // Put the failed batch back unless a newer edit superseded an entry.
        for (const key of Object.keys(batch) as (keyof ChangeSet)[]) {
          const target = this.dirty[key] as Map<string, unknown>
          for (const [id, value] of batch[key] as Map<string, unknown>) if (!target.has(id)) target.set(id, value)
        }
        if (err instanceof Error && err.name === 'OwnershipError') {
          // Never retry: the other window's newer work must not be overwritten.
          this.revokeOwnership()
          return
        }
        if (!this.owner) {
          this.setState({ heldChanges: changeSetSize(this.dirty) })
          return
        }
        const delay = this.retryDelaysMs[Math.min(this.retryCount, this.retryDelaysMs.length - 1)]
        this.retryCount++
        this.setState({ save: { ...this.state.save, status: 'error', error: describeStorageError(err) } })
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.runSave()
        }, delay)
      },
    )
    return this.inflight
  }

  /** Save everything now. Resolves true only when nothing remains unsaved. */
  async flush(): Promise<boolean> {
    this.commitTextSession()
    await this.runSave()
    if (this.inflight) await this.inflight
    return changeSetSize(this.dirty) === 0 && this.state.save.status !== 'error'
  }

  /** Retry a failed save immediately (user action). */
  retrySave(): Promise<boolean> {
    this.retryCount = 0
    return this.flush()
  }

  // ------------------------------------------------- notebooks & sections

  private nextOrder(items: { order: number }[]): number {
    return items.reduce((max, i) => Math.max(max, i.order), 0) + 1
  }

  createNotebook(title: string): { notebook: Notebook; section: Section } {
    this.assertWritable()
    const at = nowIso()
    const notebook: Notebook = { id: newId(), title: title.trim() || 'Untitled notebook', order: this.nextOrder(Object.values(this.state.data.notebooks)), createdAt: at, updatedAt: at }
    const section: Section = { id: newId(), notebookId: notebook.id, title: 'General', order: 1, createdAt: at, updatedAt: at }
    this.setData({
      notebooks: { ...this.state.data.notebooks, [notebook.id]: notebook },
      sections: { ...this.state.data.sections, [section.id]: section },
    })
    this.markDirty('notebooks', notebook.id, notebook)
    this.markDirty('sections', section.id, section)
    return { notebook, section }
  }

  renameNotebook(id: string, title: string): void {
    this.assertWritable()
    const nb = this.state.data.notebooks[id]
    if (!nb) return
    const next = { ...nb, title: title.trim() || 'Untitled notebook', updatedAt: nowIso() }
    this.setData({ notebooks: { ...this.state.data.notebooks, [id]: next } })
    this.markDirty('notebooks', id, next)
  }

  /** Pages (live or trashed) that belong to a section. */
  pagesInSection(sectionId: string, includeTrashed = false): Page[] {
    return Object.values(this.state.data.pages).filter(
      (p) => p.location.kind === 'section' && p.location.sectionId === sectionId && (includeTrashed || !p.trashedAt),
    )
  }

  /**
   * Trashed pages of a section that is being deleted move to the Inbox (still in
   * the Trash), so no page ever points at a missing section.
   */
  private rehomeTrashedPages(sectionIds: Set<string>): void {
    const at = nowIso()
    for (const p of Object.values(this.state.data.pages)) {
      if (p.trashedAt && p.location.kind === 'section' && sectionIds.has(p.location.sectionId)) {
        this.putPage({ ...p, location: { kind: 'inbox' }, updatedAt: at })
      }
    }
  }

  /** Delete an empty notebook (no live pages). Its trashed pages will restore to the Inbox. */
  deleteNotebook(id: string): boolean {
    this.assertWritable()
    const sections = Object.values(this.state.data.sections).filter((s) => s.notebookId === id)
    if (sections.some((s) => this.pagesInSection(s.id).length > 0)) return false
    this.rehomeTrashedPages(new Set(sections.map((s) => s.id)))
    const nextSections = { ...this.state.data.sections }
    for (const s of sections) {
      delete nextSections[s.id]
      this.markDirty('sections', s.id, null)
    }
    const nextNotebooks = { ...this.state.data.notebooks }
    delete nextNotebooks[id]
    this.setData({ notebooks: nextNotebooks, sections: nextSections })
    this.markDirty('notebooks', id, null)
    return true
  }

  createSection(notebookId: string, title: string): Section {
    this.assertWritable()
    const at = nowIso()
    const siblings = Object.values(this.state.data.sections).filter((s) => s.notebookId === notebookId)
    const section: Section = { id: newId(), notebookId, title: title.trim() || 'Untitled section', order: this.nextOrder(siblings), createdAt: at, updatedAt: at }
    this.setData({ sections: { ...this.state.data.sections, [section.id]: section } })
    this.markDirty('sections', section.id, section)
    return section
  }

  renameSection(id: string, title: string): void {
    this.assertWritable()
    const s = this.state.data.sections[id]
    if (!s) return
    const next = { ...s, title: title.trim() || 'Untitled section', updatedAt: nowIso() }
    this.setData({ sections: { ...this.state.data.sections, [id]: next } })
    this.markDirty('sections', id, next)
  }

  deleteSection(id: string): boolean {
    this.assertWritable()
    if (this.pagesInSection(id).length > 0) return false
    this.rehomeTrashedPages(new Set([id]))
    const next = { ...this.state.data.sections }
    delete next[id]
    this.setData({ sections: next })
    this.markDirty('sections', id, null)
    return true
  }

  // ----------------------------------------------------------------- pages

  createPage(location: PageLocation, title?: string): Page {
    this.assertWritable()
    const at = nowIso()
    const siblings = Object.values(this.state.data.pages).filter((p) => sameLocation(p.location, location))
    const page: Page = {
      id: newId(),
      title: title ?? (location.kind === 'section' ? 'Untitled page' : quickNoteTitle()),
      location,
      order: this.nextOrder(siblings),
      width: PAGE_WIDTH,
      createdAt: at,
      updatedAt: at,
      trashedAt: null,
    }
    this.setData({
      pages: { ...this.state.data.pages, [page.id]: page },
      objects: { ...this.state.data.objects, [page.id]: {} },
    })
    this.markDirty('pages', page.id, page)
    return page
  }

  private putPage(page: Page): void {
    this.setData({ pages: { ...this.state.data.pages, [page.id]: page } })
    this.markDirty('pages', page.id, page)
  }

  renamePage(id: string, title: string): void {
    this.assertWritable()
    const p = this.state.data.pages[id]
    if (!p || p.title === title) return
    this.putPage({ ...p, title, updatedAt: nowIso() })
  }

  /** Move a page; its ID, content, and links are unchanged. */
  movePage(id: string, location: PageLocation): void {
    this.assertWritable()
    const p = this.state.data.pages[id]
    if (!p || sameLocation(p.location, location)) return
    const siblings = Object.values(this.state.data.pages).filter((o) => sameLocation(o.location, location))
    this.putPage({ ...p, location, order: this.nextOrder(siblings), updatedAt: nowIso() })
  }

  trashPage(id: string): void {
    this.assertWritable()
    const p = this.state.data.pages[id]
    if (!p || p.trashedAt) return
    this.putPage({ ...p, trashedAt: nowIso() })
  }

  /** Restore from trash. If its section no longer exists, it returns to the Inbox. */
  restorePage(id: string): void {
    this.assertWritable()
    const p = this.state.data.pages[id]
    if (!p || !p.trashedAt) return
    const location: PageLocation = p.location.kind === 'section' && !this.state.data.sections[p.location.sectionId] ? { kind: 'inbox' } : p.location
    this.putPage({ ...p, location, trashedAt: null, updatedAt: nowIso() })
  }

  async deletePageForever(id: string): Promise<void> {
    this.assertWritable()
    const p = this.state.data.pages[id]
    if (!p) return
    const objects = await this.ensurePageObjects(id)
    for (const o of Object.values(objects)) this.markDirty('objects', o.id, null)
    const pages = { ...this.state.data.pages }
    delete pages[id]
    const loaded = { ...this.state.data.objects }
    delete loaded[id]
    this.histories.delete(id)
    this.setData({ pages, objects: loaded })
    this.markDirty('pages', id, null)
  }

  /** Load a page's canvas objects (once) and return them. */
  async ensurePageObjects(pageId: string): Promise<Record<string, CanvasObject>> {
    const existing = this.state.data.objects[pageId]
    if (existing) return existing
    const list = await this.repo.loadPageObjects(pageId)
    // Another call may have loaded it meanwhile; keep the in-memory version.
    const current = this.state.data.objects[pageId]
    if (current) return current
    const map = byId(list)
    // Unstored object changes for this page win over stored ones.
    for (const batch of this.pendingBatches()) {
      for (const [id, value] of batch.objects) {
        if (value && value.pageId === pageId) map[id] = value
        else if (!value) delete map[id]
      }
    }
    this.setData({ objects: { ...this.state.data.objects, [pageId]: map } })
    return map
  }

  // ------------------------------------------------------- canvas objects

  getObject(pageId: string, id: string): CanvasObject | undefined {
    return this.state.data.objects[pageId]?.[id]
  }

  private touchPage(pageId: string): void {
    const p = this.state.data.pages[pageId]
    if (p) this.putPage({ ...p, updatedAt: nowIso() })
  }

  /** Apply object states without recording history. */
  private writeObjects(pageId: string, changes: { id: string; value: CanvasObject | null }[]): void {
    const current = this.state.data.objects[pageId] ?? {}
    const next = { ...current }
    for (const { id, value } of changes) {
      if (value) next[id] = value
      else delete next[id]
      this.markDirty('objects', id, value)
    }
    this.setData({ objects: { ...this.state.data.objects, [pageId]: next } })
    this.touchPage(pageId)
  }

  private history(pageId: string): PageHistory {
    let h = this.histories.get(pageId)
    if (!h) {
      h = new PageHistory()
      this.histories.set(pageId, h)
    }
    return h
  }

  /** Callers commit any open text session before writing, so history stays ordered. */
  private pushHistory(pageId: string, label: string, changes: ObjectChange[], coalesceKey?: string): void {
    this.history(pageId).push({ label, changes, coalesceKey, at: Date.now() })
    this.setState({ historyVersion: this.state.historyVersion + 1 })
  }

  /** Add new objects as one undoable step. */
  addObjects(pageId: string, objects: CanvasObject[], label = 'Add'): void {
    this.assertWritable()
    this.commitTextSession()
    this.writeObjects(pageId, objects.map((o) => ({ id: o.id, value: o })))
    this.pushHistory(pageId, label, objects.map((o) => ({ id: o.id, before: null, after: o })))
  }

  /** Update objects as one undoable step (optionally coalesced, e.g. keyboard nudges). */
  updateObjects(pageId: string, patches: { id: string; patch: Partial<CanvasObject> }[], label: string, coalesceKey?: string): void {
    this.assertWritable()
    const changes: ObjectChange[] = []
    const writes: { id: string; value: CanvasObject }[] = []
    for (const { id, patch } of patches) {
      const before = this.getObject(pageId, id)
      if (!before) continue
      const after = { ...before, ...patch, updatedAt: nowIso() } as CanvasObject
      changes.push({ id, before, after })
      writes.push({ id, value: after })
    }
    if (writes.length === 0) return
    this.commitTextSession()
    this.writeObjects(pageId, writes)
    this.pushHistory(pageId, label, changes, coalesceKey)
  }

  removeObjects(pageId: string, ids: string[], label = 'Delete'): void {
    this.assertWritable()
    const changes: ObjectChange[] = []
    for (const id of ids) {
      const before = this.getObject(pageId, id)
      if (before) changes.push({ id, before, after: null })
    }
    if (changes.length === 0) return
    this.commitTextSession()
    this.writeObjects(pageId, changes.map((c) => ({ id: c.id, value: null })))
    this.pushHistory(pageId, label, changes)
  }

  /**
   * Remove a new text box that was left empty, as if it had never been added
   * (no undo step remains for it).
   */
  discardObject(pageId: string, id: string): void {
    if (this.state.readOnly || !this.getObject(pageId, id)) return
    if (this.textSession?.id === id) this.textSession = null
    this.writeObjects(pageId, [{ id, value: null }])
    const history = this.histories.get(pageId)
    if (history) {
      for (const stack of [history.undoStack, history.redoStack]) {
        for (let i = stack.length - 1; i >= 0; i--) {
          stack[i].changes = stack[i].changes.filter((c) => c.id !== id)
          if (stack[i].changes.length === 0) stack.splice(i, 1)
        }
      }
    }
    this.setState({ historyVersion: this.state.historyVersion + 1 })
  }

  /** Live update during a pointer gesture (no history; see commitGesture). */
  previewObject(pageId: string, id: string, patch: Partial<CanvasObject>): void {
    if (this.state.readOnly) return
    const before = this.getObject(pageId, id)
    if (!before) return
    this.writeObjects(pageId, [{ id, value: { ...before, ...patch, updatedAt: nowIso() } as CanvasObject }])
  }

  /** Record a finished gesture (move/resize) as one undoable step. */
  commitGesture(pageId: string, label: string, before: CanvasObject): void {
    if (this.state.readOnly) return
    this.commitTextSession()
    const after = this.getObject(pageId, before.id) ?? null
    this.pushHistory(pageId, label, [{ id: before.id, before, after }])
  }

  /** Text content changes from the editor. Grouped into one history step per editing session. */
  setTextDoc(pageId: string, id: string, doc: RichTextDoc): void {
    if (this.state.readOnly) return
    const obj = this.getObject(pageId, id)
    if (!obj || obj.type !== 'text') return
    this.writeObjects(pageId, [{ id, value: { ...obj, doc, updatedAt: nowIso() } }])
  }

  /** Text height is measured from the DOM; it is layout data, not an undoable edit. */
  setMeasuredHeight(pageId: string, id: string, h: number): void {
    if (this.state.readOnly) return
    const obj = this.getObject(pageId, id)
    if (!obj || Math.abs(obj.h - h) < 1) return
    this.writeObjects(pageId, [{ id, value: { ...obj, h: Math.round(h) } }])
  }

  beginTextSession(pageId: string, id: string): void {
    this.commitTextSession()
    const before = this.getObject(pageId, id)
    this.textSession = before ? { pageId, id, before } : null
  }

  endTextSession(): void {
    this.commitTextSession()
    this.textSession = null
  }

  private commitTextSession(): void {
    const s = this.textSession
    if (!s) return
    const now = this.getObject(s.pageId, s.id)
    if (now && now.type === 'text' && s.before.type === 'text' && JSON.stringify(now.doc) !== JSON.stringify(s.before.doc)) {
      // Record only the text change; geometry stays as it is now.
      const before: CanvasObject = { ...now, doc: s.before.doc }
      this.history(s.pageId).push({ label: 'Edit text', changes: [{ id: s.id, before, after: now }], fields: ['doc'], at: Date.now() })
      this.setState({ historyVersion: this.state.historyVersion + 1 })
    }
    if (now) s.before = now
  }

  canUndo(pageId: string): boolean {
    return (this.histories.get(pageId)?.undoStack.length ?? 0) > 0 || this.textSessionHasChanges(pageId)
  }

  canRedo(pageId: string): boolean {
    return (this.histories.get(pageId)?.redoStack.length ?? 0) > 0
  }

  private textSessionHasChanges(pageId: string): boolean {
    const s = this.textSession
    if (!s || s.pageId !== pageId) return false
    const now = this.getObject(pageId, s.id)
    return !!now && now.type === 'text' && s.before.type === 'text' && now.doc !== s.before.doc
  }

  private applyEntry(pageId: string, entry: HistoryEntry, side: 'before' | 'after'): void {
    const writes: { id: string; value: CanvasObject | null }[] = []
    for (const change of entry.changes) {
      const target = change[side]
      if (entry.fields && target) {
        const current = this.getObject(pageId, change.id)
        if (!current) continue
        const patched = { ...current } as Record<string, unknown>
        for (const f of entry.fields) patched[f] = (target as unknown as Record<string, unknown>)[f]
        writes.push({ id: change.id, value: patched as unknown as CanvasObject })
      } else {
        writes.push({ id: change.id, value: target })
      }
    }
    this.writeObjects(pageId, writes)
  }

  undo(pageId: string): boolean {
    if (this.state.readOnly) return false
    this.commitTextSession()
    const entry = this.histories.get(pageId)?.takeUndo()
    if (!entry) return false
    this.applyEntry(pageId, entry, 'before')
    if (this.textSession) this.textSession.before = this.getObject(pageId, this.textSession.id) ?? this.textSession.before
    this.setState({ historyVersion: this.state.historyVersion + 1 })
    return true
  }

  redo(pageId: string): boolean {
    if (this.state.readOnly) return false
    this.commitTextSession()
    const entry = this.histories.get(pageId)?.takeRedo()
    if (!entry) return false
    this.applyEntry(pageId, entry, 'after')
    if (this.textSession) this.textSession.before = this.getObject(pageId, this.textSession.id) ?? this.textSession.before
    this.setState({ historyVersion: this.state.historyVersion + 1 })
    return true
  }

  // ----------------------------------------------------------- attachments

  /** Store attachment bytes first; only then may an object reference it. */
  async addAttachment(meta: AttachmentMeta, blob: Blob): Promise<void> {
    this.assertWritable()
    await this.repo.putAttachment(meta, blob)
    this.setData({ attachments: { ...this.state.data.attachments, [meta.id]: meta } })
  }

  getBlob(id: string): Promise<Blob | undefined> {
    return this.repo.getBlob(id)
  }
}

export function sameLocation(a: PageLocation, b: PageLocation): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'section' && b.kind === 'section') return a.sectionId === b.sectionId
  return true
}
