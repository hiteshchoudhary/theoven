/**
 * Cron expressions, parsed and evaluated.
 *
 * Five fields: minute, hour, day-of-month, month, day-of-week. Supports `*`, lists (`1,15`),
 * ranges (`9-17`), steps (`*​/15`, `0-30/5`) and the usual names (`@daily`).
 *
 * Written rather than depended on: this is about a hundred lines, and a cron library is a
 * dependency in every deployment that uses the queue brick.
 */

export class CronError extends Error {
  override name = 'CronError'
}

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface Field {
  min: number
  max: number
  names?: readonly string[]
}

const FIELDS: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS },
  { min: 0, max: 6, names: DAYS },
]

export interface CronSchedule {
  readonly expression: string
  /** Whether a given time matches. Seconds and milliseconds are ignored. */
  matches(at: Date): boolean
  /** The next matching time strictly after `from`. */
  next(from?: Date): Date
}

export function parseCron(expression: string): CronSchedule {
  const normalised = ALIASES[expression.trim().toLowerCase()] ?? expression.trim()
  const parts = normalised.split(/\s+/)

  if (parts.length !== 5) {
    throw new CronError(
      `"${expression}" is not a cron expression. Five fields are expected ` +
        '(minute hour day-of-month month day-of-week), or a name like @daily.',
    )
  }

  const sets = parts.map((part, index) => parseField(part, FIELDS[index] as Field, expression))
  const [minutes, hours, days, months, weekdays] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ]

  // Standard cron: with both day-of-month and day-of-week restricted, either matching is enough.
  const dayRestricted = parts[2] !== '*'
  const weekdayRestricted = parts[4] !== '*'

  function matches(at: Date): boolean {
    if (!minutes.has(at.getMinutes()) || !hours.has(at.getHours())) return false
    if (!months.has(at.getMonth() + 1)) return false

    const dayMatch = days.has(at.getDate())
    const weekdayMatch = weekdays.has(at.getDay())

    if (dayRestricted && weekdayRestricted) return dayMatch || weekdayMatch
    if (dayRestricted) return dayMatch
    if (weekdayRestricted) return weekdayMatch
    return true
  }

  return {
    expression,
    matches,
    next: (from = new Date()) => {
      const candidate = new Date(from)
      candidate.setSeconds(0, 0)
      candidate.setMinutes(candidate.getMinutes() + 1)

      // Four years covers every February 29th case, and bounds a malformed-but-parseable
      // expression like "0 0 30 2 *" that can never match.
      const limit = 366 * 4 * 24 * 60
      for (let step = 0; step < limit; step++) {
        if (matches(candidate)) return candidate
        candidate.setMinutes(candidate.getMinutes() + 1)
      }

      throw new CronError(`"${expression}" has no next occurrence within four years.`)
    },
  }
}

function parseField(part: string, field: Field, expression: string): Set<number> {
  const values = new Set<number>()

  for (const piece of part.split(',')) {
    const [range, stepText] = piece.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)

    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`"${piece}" in "${expression}" has an invalid step.`)
    }

    let start: number
    let end: number

    if (range === '*' || range === '?') {
      start = field.min
      end = field.max
    } else if (range?.includes('-')) {
      const [from, to] = range.split('-')
      start = named(from, field, expression)
      end = named(to, field, expression)
    } else {
      start = named(range, field, expression)
      // A bare value with a step means "from here to the end", e.g. `10/15`.
      end = stepText === undefined ? start : field.max
    }

    if (start > end) {
      throw new CronError(`"${piece}" in "${expression}" counts backwards.`)
    }

    for (let value = start; value <= end; value += step) values.add(value)
  }

  if (values.size === 0) {
    throw new CronError(`"${part}" in "${expression}" matches nothing.`)
  }
  return values
}

function named(token: string | undefined, field: Field, expression: string): number {
  if (token === undefined || token === '') {
    throw new CronError(`"${expression}" has an empty field.`)
  }

  const lower = token.toLowerCase()
  const byName = field.names?.indexOf(lower)
  if (byName !== undefined && byName !== -1) {
    // Month names are 1-based, weekday names 0-based — the offset is the field's own minimum.
    return byName + field.min
  }

  const value = Number(token)
  if (!Number.isInteger(value)) {
    throw new CronError(`"${token}" in "${expression}" is not a number this field understands.`)
  }
  // Cron allows 7 for Sunday as well as 0.
  if (field.names === DAYS && value === 7) return 0
  if (value < field.min || value > field.max) {
    throw new CronError(
      `"${token}" in "${expression}" is outside this field's range (${field.min}–${field.max}).`,
    )
  }
  return value
}
