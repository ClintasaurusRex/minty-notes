import {
  PAGE_WIDTH,
  newId,
  nowIso,
  type AttachmentMeta,
  type CanvasObject,
  type Category,
  type Notebook,
  type Page,
  type PageLocation,
  type Project,
  type RichTextDoc,
  type Section,
  type Tag,
  type Task,
  type TaskStatus,
  type Template,
  type WorkspaceInfo,
  type WorkspaceRecords,
} from '../domain/types'
import { isDateOnly } from '../domain/dates'
import { isTaskPriority, isTaskStatus, moveTarget, placeTask, type TaskMove } from '../domain/tasks'
import { instantiateNote, instantiateProject, pruneTemplateRefs, templateFromPage, templateFromProject } from '../domain/templates'
import { docToPlainText } from '../domain/richtext'
import { isLinkedTo, keepExisting, ownerProjectId } from '../domain/references'
import { normalize, type PageText } from '../domain/search'
import { changeSetSize, describeStorageError, emptyChangeSet, type ChangeSet, type Repository } from '../storage/repository'
import { PageHistory, type HistoryEntry, type ObjectChange } from './history'
import { isIntendedChange, reconcileHeldChanges, type HeldChange, type ReconcileResult, type RecordKind } from './reconcile'

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error'

export interface SaveState {
  status: SaveStatus
  lastSavedAt: string | null
  error: string | null
}

export interface WorkspaceData {
  workspace: WorkspaceInfo | null
  projects: Record<string, Project>
  tasks: Record<string, Task>
  templates: Record<string, Template>
  categories: Record<string, Category>
  tags: Record<string, Tag>
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
  return { workspace: null, projects: {}, tasks: {}, templates: {}, categories: {}, tags: {}, notebooks: {}, sections: {}, pages: {}, objects: {}, attachments: {}, lastChangeAt: null, revision: 0 }
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
  /**
   * The stored version of each record as this window last read or wrote it
   * (`kind:id` → record, or null when known deleted). It is the merge base for
   * held changes.
   */
  private committed = new Map<string, unknown>()
  /** Unsaved changes kept after losing ownership: base (as known) and intended value. */
  private held = new Map<string, HeldChange>()
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
      this.committed.clear()
      for (const kind of INDEX_KINDS) for (const rec of index[kind]) this.committed.set(`${kind}:${rec.id}`, rec)
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
          projects: overlay(index.projects, (c) => c.projects),
          tasks: overlay(index.tasks, (c) => c.tasks),
          templates: overlay(index.templates, (c) => c.templates),
          categories: overlay(index.categories, (c) => c.categories),
          tags: overlay(index.tags, (c) => c.tags),
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
   * refused from then on). Changes held from a lost session are reconciled
   * against the latest stored data — never replayed as whole records — and
   * anything that cannot be applied safely goes to a "Recovered changes" note.
   */
  async becomeEditor(): Promise<ReconcileResult | null> {
    if (changeSetSize(this.dirty) > 0 && !this.owner) this.moveDirtyToHeld()
    const token = newId()
    await this.repo.claimOwnership(token)
    this.token = token
    this.owner = true
    this.retryCount = 0
    let result: ReconcileResult | null = null
    if (this.held.size > 0) {
      try {
        result = await this.reconcileAndSaveHeld()
      } catch (err) {
        // Keep the held changes and stay read-only; nothing was written.
        this.owner = false
        this.token = null
        this.setState({ save: { ...this.state.save, status: 'error', error: describeStorageError(err) } })
        throw err
      }
    }
    await this.load()
    this.setState({ readOnly: false, heldChanges: 0, owner: true })
    return result
  }

  private async reconcileAndSaveHeld(): Promise<ReconcileResult> {
    const held = [...this.held.values()]
    const index = await this.repo.loadIndex()
    const pageIds = new Set<string>()
    for (const h of held) {
      const rec = h.mine ?? h.base
      if (h.kind === 'objects' && rec) pageIds.add((rec as CanvasObject).pageId)
      if (h.kind === 'pages') pageIds.add(h.id)
    }
    const objects: Record<string, CanvasObject> = {}
    for (const pageId of pageIds) for (const o of await this.repo.loadPageObjects(pageId)) objects[o.id] = o
    const at = nowIso()
    const result = reconcileHeldChanges(
      held,
      {
        projects: byId(index.projects),
        tasks: byId(index.tasks),
        templates: byId(index.templates),
        categories: byId(index.categories),
        tags: byId(index.tags),
        notebooks: byId(index.notebooks),
        sections: byId(index.sections),
        pages: byId(index.pages),
        objects,
      },
      at,
    )
    if (changeSetSize(result.changes) > 0) {
      await this.repo.commit(result.changes, at, this.token)
      this.setState({ save: { status: 'saved', lastSavedAt: at, error: null } })
    } else {
      this.setState({ save: { ...this.state.save, status: 'saved', error: null } })
    }
    this.held.clear()
    return result
  }

  /** Move queued changes into the held set, remembering what each was based on. */
  private moveDirtyToHeld(): void {
    this.addToHeld(this.dirty, true)
    this.dirty = emptyChangeSet()
  }

  private addToHeld(changes: ChangeSet, overwrite: boolean): void {
    for (const kind of Object.keys(changes) as RecordKind[]) {
      for (const [id, value] of changes[kind] as Map<string, HeldChange['mine']>) {
        const key = `${kind}:${id}`
        const existing = this.held.get(key)
        if (existing) {
          if (overwrite) existing.mine = value
        } else {
          this.held.set(key, { kind, id, base: (this.committed.get(key) as HeldChange['base'] | undefined) ?? null, mine: value })
        }
      }
    }
    this.setState({ heldChanges: this.countHeld() })
  }

  /** Held changes that change something real (a page's timestamp alone does not count). */
  private countHeld(): number {
    let n = 0
    for (const h of this.held.values()) if (isIntendedChange(h.base, h.mine)) n++
    return n
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
    this.moveDirtyToHeld()
    const held = this.countHeld()
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
    this.held.clear()
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
    return changeSetSize(this.dirty) > 0 || this.inflight !== null || this.held.size > 0
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
        for (const kind of Object.keys(batch) as RecordKind[]) {
          for (const [id, value] of batch[kind] as Map<string, unknown>) {
            const key = `${kind}:${id}`
            this.committed.set(key, value)
            // A change held after this batch was sent is now based on what landed.
            const h = this.held.get(key)
            if (h) h.base = value as HeldChange['base']
          }
        }
        const pending = changeSetSize(this.dirty) > 0
        this.setState({ save: { status: pending ? 'pending' : 'saved', lastSavedAt: at, error: null } })
        this.setData({ lastChangeAt: at, revision })
        if (!this.owner) this.setState({ heldChanges: this.countHeld() })
        else if (pending) this.scheduleSave()
      },
      (err: unknown) => {
        this.inflight = null
        this.inflightBatch = null
        const lostOwnership = err instanceof Error && err.name === 'OwnershipError'
        if (lostOwnership || !this.owner) {
          // Never retry: the other window's newer work must not be overwritten.
          if (this.owner) this.revokeOwnership()
          this.addToHeld(batch, false) // newer held values for the same records win
          if (this.held.size > 0) {
            this.setState({ save: { ...this.state.save, status: 'error', error: 'Another window took over editing before these changes were saved.' } })
          }
          return
        }
        // Put the failed batch back unless a newer edit superseded an entry.
        for (const key of Object.keys(batch) as (keyof ChangeSet)[]) {
          const target = this.dirty[key] as Map<string, unknown>
          for (const [id, value] of batch[key] as Map<string, unknown>) if (!target.has(id)) target.set(id, value)
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
    return changeSetSize(this.dirty) === 0 && this.held.size === 0 && this.state.save.status !== 'error'
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

  createNotebook(title: string, categoryIds: string[] = []): { notebook: Notebook; section: Section } {
    this.assertWritable()
    const at = nowIso()
    const notebook: Notebook = { id: newId(), title: title.trim() || 'Untitled notebook', order: this.nextOrder(Object.values(this.state.data.notebooks)), categoryIds: [...categoryIds], createdAt: at, updatedAt: at }
    const section: Section = { id: newId(), notebookId: notebook.id, title: 'General', order: 1, categoryIds: [], createdAt: at, updatedAt: at }
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
    const section: Section = { id: newId(), notebookId, title: title.trim() || 'Untitled section', order: this.nextOrder(siblings), categoryIds: [], createdAt: at, updatedAt: at }
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
      title: title ?? (location.kind === 'section' ? 'Untitled page' : location.kind === 'project' ? 'Untitled note' : quickNoteTitle()),
      location,
      order: this.nextOrder(siblings),
      width: PAGE_WIDTH,
      categoryIds: [],
      tagIds: [],
      copiedFrom: null,
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

  /** Restore from trash. If its section or project is gone (or its project is in the Trash), it returns to the Inbox. */
  restorePage(id: string): void {
    this.assertWritable()
    const p = this.state.data.pages[id]
    if (!p || !p.trashedAt) return
    const { sections, projects } = this.state.data
    const orphaned =
      (p.location.kind === 'section' && !sections[p.location.sectionId]) ||
      (p.location.kind === 'project' && (!projects[p.location.projectId] || !!projects[p.location.projectId].trashedAt))
    const location: PageLocation = orphaned ? { kind: 'inbox' } : p.location
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
    // No project keeps a link to it, and copies only remember its title.
    const at = nowIso()
    for (const project of Object.values(this.state.data.projects)) {
      if (project.pinnedPageIds.includes(id) || project.hiddenPageIds.includes(id)) {
        this.putRecord('projects', { ...project, pinnedPageIds: project.pinnedPageIds.filter((x) => x !== id), hiddenPageIds: project.hiddenPageIds.filter((x) => x !== id), updatedAt: at })
      }
    }
    for (const copy of Object.values(this.state.data.pages)) {
      if (copy.copiedFrom?.pageId === id) this.putPage({ ...copy, copiedFrom: { ...copy.copiedFrom, pageId: null } })
    }
    // Tasks and templates drop their link to it (no dangling relationships).
    for (const task of Object.values(this.state.data.tasks)) {
      if (task.linkedPageIds.includes(id)) this.putRecord('tasks', { ...task, linkedPageIds: task.linkedPageIds.filter((x) => x !== id), updatedAt: at })
    }
    this.pruneTemplates({ page: (x) => x !== id })
  }

  /** Load a page's canvas objects (once) and return them. */
  async ensurePageObjects(pageId: string): Promise<Record<string, CanvasObject>> {
    const existing = this.state.data.objects[pageId]
    if (existing) return existing
    const list = await this.repo.loadPageObjects(pageId)
    // Another call may have loaded it meanwhile; keep the in-memory version.
    const current = this.state.data.objects[pageId]
    if (current) return current
    for (const o of list) this.committed.set(`objects:${o.id}`, o)
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

  // --------------------------------------------- projects & reusable knowledge

  /** Write one index record (project, category, tag, notebook, section, page). */
  private putRecord<K extends IndexKind>(kind: K, rec: WorkspaceData[K][string]): void {
    this.setData({ [kind]: { ...this.state.data[kind], [rec.id]: rec } } as Partial<WorkspaceData>)
    this.markDirty(kind, rec.id, rec as never)
  }

  private dropRecord(kind: IndexKind, id: string): void {
    const next = { ...this.state.data[kind] }
    delete next[id]
    this.setData({ [kind]: next } as Partial<WorkspaceData>)
    this.markDirty(kind, id, null)
  }

  createProject(fields: ProjectFields & { name: string }): Project {
    this.assertWritable()
    const project = newProject(withValidDueDate(fields), this.nextOrder(Object.values(this.state.data.projects)))
    this.putRecord('projects', project)
    return project
  }

  /** Change project details. Unchanged values are not written. */
  updateProject(id: string, patch: ProjectFields): void {
    this.assertWritable()
    const p = this.state.data.projects[id]
    if (!p) return
    const next = { ...p, ...withValidDueDate(patch) }
    if (JSON.stringify(next) === JSON.stringify(p)) return
    this.putRecord('projects', { ...next, updatedAt: nowIso() })
  }

  /** Archive keeps the complete project (notes, links, details) out of active lists. */
  setProjectArchived(id: string, archived: boolean): void {
    this.assertWritable()
    const p = this.state.data.projects[id]
    if (!p || !!p.archivedAt === archived) return
    const at = nowIso()
    this.putRecord('projects', { ...p, archivedAt: archived ? at : null, updatedAt: at })
  }

  /** Move a project (with its notes) to the Trash. Linked library pages are not touched. */
  trashProject(id: string): void {
    this.assertWritable()
    const p = this.state.data.projects[id]
    if (!p || p.trashedAt) return
    const at = nowIso()
    this.putRecord('projects', { ...p, trashedAt: at, updatedAt: at })
  }

  restoreProject(id: string): void {
    this.assertWritable()
    const p = this.state.data.projects[id]
    if (!p || !p.trashedAt) return
    this.putRecord('projects', { ...p, trashedAt: null, updatedAt: nowIso() })
  }

  /**
   * Delete a trashed project forever. Its own notes are not lost: they move to
   * the page Trash (restorable to the Inbox). Shared library pages it linked to
   * are never affected. Returns how many notes moved to the Trash.
   */
  deleteProjectForever(id: string): number {
    this.assertWritable()
    if (!this.state.data.projects[id]) return 0
    const at = nowIso()
    let moved = 0
    for (const page of Object.values(this.state.data.pages)) {
      if (ownerProjectId(page) !== id) continue
      this.putPage({ ...page, location: { kind: 'inbox' }, trashedAt: page.trashedAt ?? at, updatedAt: at })
      moved++
    }
    // Its tasks belong to it and go with it (the confirmation names how many).
    for (const task of this.projectTasks(id)) this.dropRecord('tasks', task.id)
    this.dropRecord('projects', id)
    return moved
  }

  /** Link a page to a project as a reference (the original page, not a copy). */
  pinReference(projectId: string, pageId: string): void {
    this.assertWritable()
    const p = this.state.data.projects[projectId]
    const page = this.state.data.pages[pageId]
    if (!p || !page || ownerProjectId(page) === projectId) return
    this.updateProject(projectId, {
      pinnedPageIds: p.pinnedPageIds.includes(pageId) ? p.pinnedPageIds : [...p.pinnedPageIds, pageId],
      hiddenPageIds: p.hiddenPageIds.filter((x) => x !== pageId),
    })
  }

  unpinReference(projectId: string, pageId: string): void {
    this.assertWritable()
    const p = this.state.data.projects[projectId]
    if (!p) return
    this.updateProject(projectId, { pinnedPageIds: p.pinnedPageIds.filter((x) => x !== pageId) })
  }

  /** Hide a suggested or pinned reference from this project. The page itself is untouched. */
  hideReference(projectId: string, pageId: string): void {
    this.assertWritable()
    const p = this.state.data.projects[projectId]
    if (!p || !this.state.data.pages[pageId]) return
    this.updateProject(projectId, {
      pinnedPageIds: p.pinnedPageIds.filter((x) => x !== pageId),
      hiddenPageIds: p.hiddenPageIds.includes(pageId) ? p.hiddenPageIds : [...p.hiddenPageIds, pageId],
    })
  }

  unhideReference(projectId: string, pageId: string): void {
    this.assertWritable()
    const p = this.state.data.projects[projectId]
    if (!p) return
    this.updateProject(projectId, { hiddenPageIds: p.hiddenPageIds.filter((x) => x !== pageId) })
  }

  /**
   * Make an independent project copy of a page: new page and object IDs, owned
   * by the project. Image bytes are shared (they never change). The original is
   * no longer listed as a linked reference in this project (unpinned or hidden),
   * so the project shows its own copy instead.
   */
  async makeProjectCopy(projectId: string, pageId: string): Promise<Page> {
    this.assertWritable()
    const project = this.state.data.projects[projectId]
    const source = this.state.data.pages[pageId]
    if (!project || !source) throw new Error('The page or project no longer exists.')
    const objects = Object.values(await this.ensurePageObjects(pageId))
    this.assertWritable()
    this.commitTextSession()
    const at = nowIso()
    const siblings = Object.values(this.state.data.pages).filter((p) => ownerProjectId(p) === projectId)
    const copy: Page = {
      ...source,
      id: newId(),
      location: { kind: 'project', projectId },
      order: this.nextOrder(siblings),
      categoryIds: [...source.categoryIds],
      tagIds: [...source.tagIds],
      copiedFrom: { pageId: source.id, title: source.title, at },
      createdAt: at,
      updatedAt: at,
      trashedAt: null,
    }
    const copies: Record<string, CanvasObject> = {}
    for (const o of objects) {
      const c = { ...structuredClone(o), id: newId(), pageId: copy.id, createdAt: at, updatedAt: at } as CanvasObject
      copies[c.id] = c
    }
    this.setData({ pages: { ...this.state.data.pages, [copy.id]: copy }, objects: { ...this.state.data.objects, [copy.id]: copies } })
    this.markDirty('pages', copy.id, copy)
    for (const c of Object.values(copies)) this.markDirty('objects', c.id, c)
    const latest = this.state.data.projects[projectId]
    if (latest.pinnedPageIds.includes(pageId)) this.unpinReference(projectId, pageId)
    if (isLinkedTo(this.state.data.projects[projectId], source, this.state.data)) this.hideReference(projectId, pageId)
    return copy
  }

  private findByName<T extends { name: string }>(items: Record<string, T>, name: string): T | undefined {
    const key = normalize(name.trim())
    return Object.values(items).find((i) => normalize(i.name.trim()) === key)
  }

  /** Create a system category, or return the existing one with the same name. */
  createCategory(name: string): Category {
    this.assertWritable()
    const clean = name.trim() || 'Untitled category'
    const existing = this.findByName(this.state.data.categories, clean)
    if (existing) return existing
    const at = nowIso()
    const category: Category = { id: newId(), name: clean, order: this.nextOrder(Object.values(this.state.data.categories)), createdAt: at, updatedAt: at }
    this.putRecord('categories', category)
    return category
  }

  renameCategory(id: string, name: string): void {
    this.assertWritable()
    const c = this.state.data.categories[id]
    const clean = name.trim()
    if (!c || !clean || c.name === clean) return
    this.putRecord('categories', { ...c, name: clean, updatedAt: nowIso() })
  }

  /** Delete a category and remove it from every notebook, section, page, and project. */
  deleteCategory(id: string): void {
    this.assertWritable()
    if (!this.state.data.categories[id]) return
    this.stripLabel('categoryIds', id)
    this.pruneTemplates({ category: (x) => x !== id })
    this.dropRecord('categories', id)
  }

  createTag(name: string): Tag {
    this.assertWritable()
    const clean = name.trim().replace(/^#/, '') || 'tag'
    const existing = this.findByName(this.state.data.tags, clean)
    if (existing) return existing
    const at = nowIso()
    const tag: Tag = { id: newId(), name: clean, createdAt: at, updatedAt: at }
    this.putRecord('tags', tag)
    return tag
  }

  renameTag(id: string, name: string): void {
    this.assertWritable()
    const t = this.state.data.tags[id]
    const clean = name.trim().replace(/^#/, '')
    if (!t || !clean || t.name === clean) return
    this.putRecord('tags', { ...t, name: clean, updatedAt: nowIso() })
  }

  deleteTag(id: string): void {
    this.assertWritable()
    if (!this.state.data.tags[id]) return
    this.stripLabel('tagIds', id)
    this.pruneTemplates({ tag: (x) => x !== id })
    this.dropRecord('tags', id)
  }

  private stripLabel(field: 'categoryIds' | 'tagIds', id: string): void {
    const at = nowIso()
    const kinds: LabelTarget[] = field === 'tagIds' ? ['pages'] : ['notebooks', 'sections', 'pages', 'projects']
    for (const kind of kinds) {
      for (const rec of Object.values(this.state.data[kind]) as (Notebook | Section | Page | Project)[]) {
        const ids = (rec as unknown as Record<string, string[]>)[field]
        if (ids.includes(id)) this.putRecord(kind, { ...rec, [field]: ids.filter((x) => x !== id), updatedAt: at } as never)
      }
    }
  }

  /** Set the system categories of a notebook, section, page, or project (existing categories only). */
  setCategories(kind: LabelTarget, id: string, categoryIds: string[]): void {
    this.assertWritable()
    const rec = this.state.data[kind][id] as Notebook | Section | Page | Project | undefined
    if (!rec) return
    const ids = keepExisting([...new Set(categoryIds)], (c) => !!this.state.data.categories[c])
    if (JSON.stringify(ids) === JSON.stringify(rec.categoryIds)) return
    this.putRecord(kind, { ...rec, categoryIds: ids, updatedAt: nowIso() } as never)
  }

  setPageTags(pageId: string, tagIds: string[]): void {
    this.assertWritable()
    const p = this.state.data.pages[pageId]
    if (!p) return
    const ids = keepExisting([...new Set(tagIds)], (t) => !!this.state.data.tags[t])
    if (JSON.stringify(ids) === JSON.stringify(p.tagIds)) return
    this.putPage({ ...p, tagIds: ids, updatedAt: nowIso() })
  }

  /**
   * Plain text and image attachments of every page, for local search. Stored
   * objects are read once; pages open in this window use their in-memory
   * (possibly not yet saved) version.
   */
  async loadSearchTexts(): Promise<Map<string, PageText>> {
    const byPage = new Map<string, CanvasObject[]>()
    for (const o of await this.repo.loadAllObjects()) {
      const list = byPage.get(o.pageId)
      if (list) list.push(o)
      else byPage.set(o.pageId, [o])
    }
    for (const [pageId, objects] of Object.entries(this.state.data.objects)) byPage.set(pageId, Object.values(objects))
    const texts = new Map<string, PageText>()
    for (const [pageId, objects] of byPage) {
      const sorted = [...objects].sort((a, b) => a.y - b.y || a.x - b.x)
      const text = sorted
        .filter((o) => o.type === 'text')
        .map((o) => docToPlainText(o.doc))
        .join('\n')
      const attachmentIds = sorted.filter((o) => o.type === 'image').map((o) => o.attachmentId)
      texts.set(pageId, { text, attachmentIds })
    }
    return texts
  }

  // ----------------------------------------------------------------- tasks

  /** Every task of a project (any status). */
  projectTasks(projectId: string): Task[] {
    return Object.values(this.state.data.tasks).filter((t) => t.projectId === projectId)
  }

  /** Add a task to a project's board (at the end of its column). */
  createTask(projectId: string, fields: TaskFields & { title: string }): Task {
    this.assertWritable()
    if (!this.state.data.projects[projectId]) throw new Error('The project no longer exists.')
    const at = nowIso()
    const clean = cleanTaskFields(fields, this.state.data.pages)
    const status: TaskStatus = clean.status ?? 'todo'
    const column = this.projectTasks(projectId).filter((t) => t.status === status)
    const task: Task = {
      id: newId(),
      projectId,
      title: '',
      description: '',
      status,
      priority: 'normal',
      dueDate: null,
      linkedPageIds: [],
      ...clean,
      order: this.nextOrder(column),
      completedAt: status === 'done' ? at : null,
      createdAt: at,
      updatedAt: at,
    }
    task.title = task.title.trim() || 'Untitled task'
    this.putRecord('tasks', task)
    return task
  }

  /**
   * Change a task's details. Invalid values (an unknown status or priority, a
   * due date that is not a real `YYYY-MM-DD` date, links to missing pages) are
   * ignored, so they can never reach storage or a backup.
   */
  updateTask(id: string, patch: TaskFields): void {
    this.assertWritable()
    const t = this.state.data.tasks[id]
    if (!t) return
    const clean = cleanTaskFields(patch, this.state.data.pages)
    if (clean.status && clean.status !== t.status) {
      // A status change is a move: append to the end of the new column.
      this.moveTask(id, clean.status, null)
      delete clean.status
    }
    const current = this.state.data.tasks[id]
    const next = { ...current, ...clean }
    if (JSON.stringify(next) === JSON.stringify(current)) return
    this.putRecord('tasks', { ...next, updatedAt: nowIso() })
  }

  /** Move a task to a column, before another task (or to the end). Completion follows the Done column. */
  moveTask(id: string, status: TaskStatus, beforeId: string | null): void {
    this.assertWritable()
    const task = this.state.data.tasks[id]
    if (!task || !isTaskStatus(status)) return
    const at = nowIso()
    for (const change of placeTask(Object.values(this.state.data.tasks), id, status, beforeId)) {
      const t = this.state.data.tasks[change.id]
      const statusChanged = t.status !== change.status
      this.putRecord('tasks', {
        ...t,
        status: change.status,
        order: change.order,
        completedAt: statusChanged ? (change.status === 'done' ? at : null) : t.completedAt,
        updatedAt: statusChanged || t.id === id ? at : t.updatedAt,
      })
    }
  }

  /** Keyboard move (left/right between columns, up/down within one). Returns false at an edge. */
  nudgeTask(id: string, move: TaskMove): boolean {
    this.assertWritable()
    const task = this.state.data.tasks[id]
    if (!task) return false
    const target = moveTarget(Object.values(this.state.data.tasks), task, move)
    if (!target) return false
    this.moveTask(id, target.status, target.beforeId)
    return true
  }

  /** Complete (to the end of Done) or reopen (to the end of To do). */
  setTaskDone(id: string, done: boolean): void {
    this.assertWritable()
    const t = this.state.data.tasks[id]
    if (!t || (t.status === 'done') === done) return
    this.moveTask(id, done ? 'done' : 'todo', null)
  }

  deleteTask(id: string): void {
    this.assertWritable()
    if (!this.state.data.tasks[id]) return
    this.dropRecord('tasks', id)
  }

  /** Link a task to an existing note (by ID; the note is not copied). */
  linkTaskPage(taskId: string, pageId: string): void {
    this.assertWritable()
    const t = this.state.data.tasks[taskId]
    if (!t || !this.state.data.pages[pageId] || t.linkedPageIds.includes(pageId)) return
    this.putRecord('tasks', { ...t, linkedPageIds: [...t.linkedPageIds, pageId], updatedAt: nowIso() })
  }

  unlinkTaskPage(taskId: string, pageId: string): void {
    this.assertWritable()
    const t = this.state.data.tasks[taskId]
    if (!t || !t.linkedPageIds.includes(pageId)) return
    this.putRecord('tasks', { ...t, linkedPageIds: t.linkedPageIds.filter((x) => x !== pageId), updatedAt: nowIso() })
  }

  // ------------------------------------------------------------- templates

  /** Save a page as a reusable note template (a snapshot; the page stays independent). */
  async createTemplateFromPage(pageId: string, name: string): Promise<Template> {
    this.assertWritable()
    const page = this.state.data.pages[pageId]
    if (!page) throw new Error('The page no longer exists.')
    const objects = Object.values(await this.ensurePageObjects(pageId))
    this.assertWritable()
    this.commitTextSession()
    const template = templateFromPage(this.state.data.pages[pageId] ?? page, objects, name, nowIso())
    this.putRecord('templates', template)
    return template
  }

  /** Save a project's reusable settings, live notes, and tasks as a project template. */
  async createTemplateFromProject(projectId: string, name: string): Promise<Template> {
    this.assertWritable()
    const project = this.state.data.projects[projectId]
    if (!project) throw new Error('The project no longer exists.')
    const owned = Object.values(this.state.data.pages)
      .filter((p) => !p.trashedAt && ownerProjectId(p) === projectId)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    const notes: { page: Page; objects: CanvasObject[] }[] = []
    for (const page of owned) notes.push({ page, objects: Object.values(await this.ensurePageObjects(page.id)) })
    this.assertWritable()
    this.commitTextSession()
    const template = templateFromProject(this.state.data.projects[projectId] ?? project, notes, this.projectTasks(projectId), this.state.data.pages, name, nowIso())
    this.putRecord('templates', template)
    return template
  }

  updateTemplate(id: string, patch: { name?: string; description?: string }): void {
    this.assertWritable()
    const t = this.state.data.templates[id]
    if (!t) return
    const next = { ...t, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) }
    if (next.name === t.name && next.description === t.description) return
    this.putRecord('templates', { ...next, updatedAt: nowIso() })
  }

  /** Delete a template definition. Notes and projects made from it are independent and stay. */
  deleteTemplate(id: string): void {
    this.assertWritable()
    if (!this.state.data.templates[id]) return
    this.dropRecord('templates', id)
  }

  /** A new, independent note from a note template (or from one note of a project template). */
  createPageFromTemplate(templateId: string, location: PageLocation, noteIndex = 0): Page {
    this.assertWritable()
    const template = this.state.data.templates[templateId]
    const note = template?.notes[noteIndex]
    if (!note) throw new Error('The template no longer exists.')
    this.commitTextSession()
    const siblings = Object.values(this.state.data.pages).filter((p) => sameLocation(p.location, location))
    const { page, objects } = instantiateNote(note, location, this.nextOrder(siblings), nowIso(), this.state.data)
    const map = Object.fromEntries(objects.map((o) => [o.id, o]))
    this.setData({ pages: { ...this.state.data.pages, [page.id]: page }, objects: { ...this.state.data.objects, [page.id]: map } })
    this.markDirty('pages', page.id, page)
    for (const o of objects) this.markDirty('objects', o.id, o)
    return page
  }

  /** A new, independent project (with its own notes and tasks) from a project template. */
  createProjectFromTemplate(templateId: string, name: string): Project {
    this.assertWritable()
    const template = this.state.data.templates[templateId]
    if (!template || template.kind !== 'project') throw new Error('The project template no longer exists.')
    this.commitTextSession()
    const made = instantiateProject(template, name, this.nextOrder(Object.values(this.state.data.projects)), nowIso(), this.state.data, (fields, order, at) => newProject(fields, order, at))
    this.putRecord('projects', made.project)
    const objectsByPage: Record<string, Record<string, CanvasObject>> = {}
    for (const page of made.pages) objectsByPage[page.id] = {}
    for (const o of made.objects) objectsByPage[o.pageId][o.id] = o
    this.setData({
      pages: { ...this.state.data.pages, ...Object.fromEntries(made.pages.map((p) => [p.id, p])) },
      objects: { ...this.state.data.objects, ...objectsByPage },
    })
    for (const page of made.pages) this.markDirty('pages', page.id, page)
    for (const o of made.objects) this.markDirty('objects', o.id, o)
    for (const task of made.tasks) this.putRecord('tasks', task)
    return made.project
  }

  /** Remove template references to deleted categories, tags, or pages. */
  private pruneTemplates(keep: Partial<{ category: (id: string) => boolean; tag: (id: string) => boolean; page: (id: string) => boolean }>): void {
    const at = nowIso()
    const all = () => true
    for (const t of Object.values(this.state.data.templates)) {
      const next = pruneTemplateRefs(t, { category: keep.category ?? all, tag: keep.tag ?? all, page: keep.page ?? all })
      if (next !== t) this.putRecord('templates', { ...next, updatedAt: at })
    }
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
  if (a.kind === 'project' && b.kind === 'project') return a.projectId === b.projectId
  return true
}

/**
 * A due date must be a real `YYYY-MM-DD` date (or null): anything else would
 * make every later backup fail validation. Invalid values are ignored, so the
 * previous date stays.
 */
function withValidDueDate<T extends { dueDate?: string | null }>(fields: T): T {
  if (fields.dueDate === undefined || fields.dueDate === null || isDateOnly(fields.dueDate)) return fields
  const rest = { ...fields }
  delete rest.dueDate
  return rest
}

const INDEX_KINDS = ['projects', 'tasks', 'templates', 'categories', 'tags', 'notebooks', 'sections', 'pages'] as const
type IndexKind = (typeof INDEX_KINDS)[number]
type LabelTarget = 'notebooks' | 'sections' | 'pages' | 'projects'

export type TaskFields = Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'dueDate' | 'linkedPageIds'>>

/** Keep only valid task values (see updateTask). */
function cleanTaskFields(fields: TaskFields, pages: Record<string, Page>): TaskFields {
  const out: TaskFields = { ...withValidDueDate(fields) }
  if (out.title !== undefined && typeof out.title !== 'string') delete out.title
  if (out.description !== undefined && typeof out.description !== 'string') delete out.description
  if (out.status !== undefined && !isTaskStatus(out.status)) delete out.status
  if (out.priority !== undefined && !isTaskPriority(out.priority)) delete out.priority
  if (out.linkedPageIds !== undefined) out.linkedPageIds = [...new Set(out.linkedPageIds)].filter((id) => !!pages[id])
  return out
}

export type ProjectFields = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'order' | 'archivedAt' | 'trashedAt'>>

export function newProject(fields: ProjectFields & { name: string }, order: number, at = nowIso()): Project {
  return {
    id: newId(),
    customer: '',
    site: '',
    jobNumber: '',
    status: 'active',
    dueDate: null,
    description: '',
    contacts: [],
    equipment: [],
    software: [],
    fileLocations: [],
    categoryIds: [],
    pinnedPageIds: [],
    hiddenPageIds: [],
    ...fields,
    name: fields.name.trim() || 'Untitled project',
    order,
    archivedAt: null,
    trashedAt: null,
    createdAt: at,
    updatedAt: at,
  }
}
