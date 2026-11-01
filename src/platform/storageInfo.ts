export interface StorageInfo {
  supported: boolean
  persisted: boolean | null
  usage: number | null
  quota: number | null
}

/** Ask the browser to keep this site's data under storage pressure, and report the result. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return null
  }
}

export async function readStorageInfo(): Promise<StorageInfo> {
  if (!navigator.storage?.estimate) return { supported: false, persisted: null, usage: null, quota: null }
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate().catch(() => ({}) as StorageEstimate),
    navigator.storage.persisted?.().catch(() => null) ?? null,
  ])
  return { supported: true, persisted, usage: estimate.usage ?? null, quota: estimate.quota ?? null }
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}
