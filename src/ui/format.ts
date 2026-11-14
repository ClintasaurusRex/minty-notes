const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const dateTimeFull = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return dateTime.format(new Date(iso))
}

export function fullDateTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  return dateTimeFull.format(new Date(iso))
}

/** “just now”, “5 min ago”, “3 h ago”, or a date. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const diff = Math.max(0, now - Date.parse(iso))
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return shortDateTime(iso)
}
