export interface Notice {
  id: number
  kind: 'error' | 'info' | 'success'
  text: string
}

let notices: Notice[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export const noticeStore = {
  getState: (): Notice[] => notices,
  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

export function dismissNotice(id: number): void {
  notices = notices.filter((n) => n.id !== id)
  emit()
}

/** Show a short message. Errors stay longer and can be dismissed. */
export function notify(kind: Notice['kind'], text: string, timeoutMs = kind === 'error' ? 10000 : 4000): void {
  const id = nextId++
  notices = [...notices.slice(-3), { id, kind, text }]
  emit()
  setTimeout(() => dismissNotice(id), timeoutMs)
}
