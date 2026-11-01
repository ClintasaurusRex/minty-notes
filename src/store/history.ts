import type { CanvasObject } from '../domain/types'

/** One object's state before and after an edit. `null` = absent. */
export interface ObjectChange {
  id: string
  before: CanvasObject | null
  after: CanvasObject | null
}

export interface HistoryEntry {
  label: string
  changes: ObjectChange[]
  coalesceKey?: string
  /** When set, undo/redo patch only these fields onto the current object. */
  fields?: ('doc')[]
  at: number
}

const MAX_ENTRIES = 200
const COALESCE_MS = 1200

function sameObject(a: CanvasObject | null, b: CanvasObject | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Per-page undo/redo of canvas edits. Entries record object-level
 * before/after states, so independent edits never undo each other.
 */
export class PageHistory {
  undoStack: HistoryEntry[] = []
  redoStack: HistoryEntry[] = []

  push(entry: HistoryEntry): void {
    const changes = entry.changes.filter((c) => !sameObject(c.before, c.after))
    if (changes.length === 0) return
    const top = this.undoStack[this.undoStack.length - 1]
    if (entry.coalesceKey && top && top.coalesceKey === entry.coalesceKey && entry.at - top.at < COALESCE_MS) {
      for (const change of changes) {
        const existing = top.changes.find((c) => c.id === change.id)
        if (existing) existing.after = change.after
        else top.changes.push(change)
      }
      top.at = entry.at
    } else {
      this.undoStack.push({ ...entry, changes })
      if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift()
    }
    this.redoStack = []
  }

  takeUndo(): HistoryEntry | undefined {
    const entry = this.undoStack.pop()
    if (entry) this.redoStack.push(entry)
    return entry
  }

  takeRedo(): HistoryEntry | undefined {
    const entry = this.redoStack.pop()
    if (entry) this.undoStack.push(entry)
    return entry
  }
}
