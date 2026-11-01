import type { ProjectStatus } from '../domain/types'

export const STATUS_LABELS: Record<ProjectStatus, string> = { planned: 'Planned', active: 'Active', 'on-hold': 'On hold', complete: 'Complete' }

/** Only http(s) links are opened; anything else is shown for copying. */
export function safeUrl(value: string): string | null {
  try {
    const u = new URL(value.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
