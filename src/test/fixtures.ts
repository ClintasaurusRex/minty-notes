import { IdbRepository } from '../storage/repository'
import { WorkspaceStore } from '../store/workspaceStore'

let counter = 0

/** A fresh, isolated workspace backed by fake-indexeddb. */
export async function freshStore(options: ConstructorParameters<typeof WorkspaceStore>[1] = {}) {
  const repo = await IdbRepository.open(`minty-test-${Date.now()}-${counter++}`)
  const store = new WorkspaceStore(repo, { debounceMs: 5, maxWaitMs: 20, retryDelaysMs: [10], ...options })
  await store.load()
  return { repo, store }
}

/** Smallest valid PNG (1×1 transparent), used as a stand-in screenshot. */
export const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)
