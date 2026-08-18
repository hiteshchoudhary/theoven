export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

/** Structured fields attached to a log line. */
export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** Returns a logger that stamps `fields` onto every line — used to bind the request id. */
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  /** `json` for machines, `pretty` for humans. Defaults to pretty outside production. */
  format?: 'json' | 'pretty'
  /** Overridable so tests can capture output without touching stdout. */
  write?: (line: string) => void
}

const ESC = '\u001b'
const COLOURS: Record<string, string> = {
  debug: `${ESC}[90m`,
  info: `${ESC}[36m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`,
}
const RESET = `${ESC}[0m`
const DIM = `${ESC}[2m`

/**
 * Oven's built-in logger.
 *
 * Deliberately small. It exists so that `ctx.log` always works with no setup, not to compete
 * with pino — `createApp({ logger })` accepts any object satisfying `Logger`, so swapping in
 * pino or winston is a one-liner when an app outgrows this.
 *
 * Fields are never redacted here, so secrets must not be passed in. Token capture (§1.3) keeps
 * `ctx.token` out of the fields it produces for exactly this reason.
 */
export class ConsoleLogger implements Logger {
  private readonly threshold: number
  private readonly format: 'json' | 'pretty'
  private readonly write: (line: string) => void
  private readonly bound: LogFields

  constructor(options: LoggerOptions = {}, bound: LogFields = {}) {
    this.threshold = LEVEL_ORDER[options.level ?? 'info']
    this.format = options.format ?? (Bun.env.NODE_ENV === 'production' ? 'json' : 'pretty')
    this.write = options.write ?? ((line) => console.log(line))
    this.bound = bound
  }

  private emit(level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.threshold) return

    const merged = fields ? { ...this.bound, ...fields } : this.bound

    if (this.format === 'json') {
      this.write(
        JSON.stringify({
          level,
          time: new Date().toISOString(),
          message,
          ...merged,
        }),
      )
      return
    }

    const colour = COLOURS[level] ?? ''
    const keys = Object.keys(merged)
    const suffix =
      keys.length === 0
        ? ''
        : ` ${DIM}${keys.map((key) => `${key}=${stringify(merged[key])}`).join(' ')}${RESET}`
    this.write(`${colour}${level.toUpperCase().padEnd(5)}${RESET} ${message}${suffix}`)
  }

  debug(message: string, fields?: LogFields): void {
    this.emit('debug', message, fields)
  }

  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields)
  }

  error(message: string, fields?: LogFields): void {
    this.emit('error', message, fields)
  }

  child(fields: LogFields): Logger {
    return new ConsoleLogger(
      { level: levelFor(this.threshold), format: this.format, write: this.write },
      { ...this.bound, ...fields },
    )
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function levelFor(threshold: number): LogLevel {
  for (const [level, order] of Object.entries(LEVEL_ORDER)) {
    if (order === threshold) return level as LogLevel
  }
  return 'info'
}

/** A logger that discards everything. The default in tests, so output stays readable. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger
  },
}
