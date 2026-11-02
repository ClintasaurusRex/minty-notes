import type { DateOnly } from './types'

/**
 * Date-only values (`YYYY-MM-DD`) such as due dates. They are compared and
 * displayed as calendar dates in the user's local calendar and are never turned
 * into timestamps, so they cannot shift with time zones.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * UTC midnight of a calendar date. `Date.UTC` maps years 0–99 to 1900–1999,
 * so the year is set separately (Chrome's date field yields e.g. `0099-12-15`
 * when a two-digit year is typed).
 */
function utcDate(y: number, m: number, d: number): Date {
  const date = new Date(Date.UTC(2000, m - 1, d))
  date.setUTCFullYear(y, m - 1, d)
  return date
}

export function isDateOnly(value: unknown): value is DateOnly {
  if (typeof value !== 'string') return false
  const m = DATE_ONLY.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = utcDate(y, mo, d)
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
}

/** Today's date in the local calendar. */
export function todayDateOnly(now = new Date()): DateOnly {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function dayNumber(value: DateOnly): number {
  const [y, m, d] = value.split('-').map(Number)
  return utcDate(y, m, d).getTime() / 86_400_000
}

/** Whole days from `today` to `value` (negative when past). */
export function daysUntil(value: DateOnly, today: DateOnly = todayDateOnly()): number {
  return dayNumber(value) - dayNumber(today)
}

const display = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })

/** Human-readable calendar date (formatted in UTC so the day never moves). */
export function formatDateOnly(value: DateOnly): string {
  if (!isDateOnly(value)) return value
  return display.format(new Date(dayNumber(value) * 86_400_000))
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later'

export function dueState(value: DateOnly, today: DateOnly = todayDateOnly()): { tone: DueTone; text: string } {
  const days = daysUntil(value, today)
  if (days < 0) return { tone: 'overdue', text: `Overdue · ${formatDateOnly(value)}` }
  if (days === 0) return { tone: 'today', text: 'Due today' }
  if (days <= 7) return { tone: 'soon', text: `Due in ${days} day${days === 1 ? '' : 's'}` }
  return { tone: 'later', text: `Due ${formatDateOnly(value)}` }
}
