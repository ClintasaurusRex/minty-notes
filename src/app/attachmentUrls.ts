import type { WorkspaceStore } from '../store/workspaceStore'

/** Object URLs for stored attachment bytes, created on demand and cached. */
export class AttachmentUrls {
  private readonly store: WorkspaceStore
  private readonly urls = new Map<string, string>()
  private readonly pending = new Map<string, Promise<string | null>>()

  constructor(store: WorkspaceStore) {
    this.store = store
  }

  peek(id: string): string | undefined {
    return this.urls.get(id)
  }

  get(id: string): Promise<string | null> {
    const cached = this.urls.get(id)
    if (cached) return Promise.resolve(cached)
    let p = this.pending.get(id)
    if (!p) {
      p = this.store.getBlob(id).then((blob) => {
        this.pending.delete(id)
        if (!blob) return null
        const url = URL.createObjectURL(blob)
        this.urls.set(id, url)
        return url
      })
      this.pending.set(id, p)
    }
    return p
  }

  /** Release all URLs (after a restore replaced the attachments). */
  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    this.pending.clear()
  }
}
