import { formatPath, type StandardSchemaV1 } from './standard-schema'

/**
 * Environment variables: reading them safely, and validating them at boot.
 *
 * Two tools for two jobs. `env.*` reads a single variable with a sensible parse; `defineEnv`
 * validates the whole configuration against a schema. Reaching for a schema to read one
 * optional flag is overkill, and reading forty variables one at a time is worse.
 *
 * **Loading `.env` files is Bun's job, not ours.** Bun already reads `.env`, `.env.local`,
 * `.env.<NODE_ENV>` and applies the precedence between them, so shipping a dotenv would be
 * duplicating a runtime feature — and a second implementation with slightly different
 * precedence is a genuinely nasty thing to debug.
 */

/**
 * Typed environment variables, validated at boot.
 *
 * The failure this exists to prevent: a missing `DATABASE_URL` that surfaces forty minutes into
 * production as `connect ECONNREFUSED undefined:undefined`, from a stack trace pointing at a
 * connection pool rather than at the config. An app should refuse to start instead.
 *
 * ```ts
 * export const env = defineEnv(
 *   z.object({
 *     DATABASE_URL: z.url(),
 *     PORT: z.coerce.number().default(3000),
 *     STRIPE_KEY: z.string().startsWith('sk_'),
 *   }),
 * )
 *
 * env.PORT  // number
 * ```
 *
 * Every problem is reported at once. Fixing environment configuration one variable per restart
 * is a genuinely awful way to spend twenty minutes.
 */

/** Raised when the environment does not satisfy the schema. Formatted for a terminal. */
export class EnvError extends Error {
  override name = 'EnvError'
  readonly issues: ReadonlyArray<{ path: string; message: string }>

  constructor(issues: ReadonlyArray<{ path: string; message: string }>) {
    const lines = issues.map((issue) => `  ${issue.path || '(root)'}: ${issue.message}`)
    super(`Invalid environment:\n${lines.join('\n')}`)
    this.issues = issues
  }
}

export interface EnvOptions {
  /** Source of values. Defaults to the process environment. */
  source?: Record<string, string | undefined>
}

/**
 * Validates the environment against a schema and returns the typed result.
 *
 * Synchronous by design: this runs at module load, before anything else, and an async check
 * would mean the rest of the module body ran against an unvalidated environment. A schema whose
 * validation is asynchronous is rejected rather than silently awaited.
 *
 * @throws {EnvError} listing every problem found
 */
export function defineEnv<Schema extends StandardSchemaV1>(
  schema: Schema,
  options: EnvOptions = {},
): StandardSchemaV1.InferOutput<Schema> {
  const source = options.source ?? (Bun.env as Record<string, string | undefined>)

  // A plain object rather than the live environment: schema libraries walk their input, and
  // `process.env` is an exotic object whose behaviour under enumeration differs by runtime.
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) values[key] = value
  }

  const result = schema['~standard'].validate(values)

  if (result instanceof Promise) {
    throw new EnvError([
      {
        path: '',
        message:
          'Environment validation must be synchronous. An async schema would let the rest of ' +
          'the module run before the check finished.',
      },
    ])
  }

  if (result.issues) {
    throw new EnvError(
      result.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    )
  }

  return result.value as StandardSchemaV1.InferOutput<Schema>
}

// ---------------------------------------------------------------------------------------
// Reading one variable at a time
// ---------------------------------------------------------------------------------------

/**
 * Variable names whose values must never appear in an error message or a dump.
 *
 * Matched loosely on purpose. A false positive redacts something harmless; a false negative
 * puts a production database password into a log aggregator, and there is no taking it back.
 */
const SECRET_PATTERN =
  /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|SALT|CERT|DSN|DATABASE_URL|CONNECTION)/i

export function isSecretName(name: string): boolean {
  return SECRET_PATTERN.test(name)
}

/** Renders a value for an error message, hiding it when the name suggests a secret. */
function show(name: string, value: string): string {
  return isSecretName(name) ? '[redacted]' : JSON.stringify(value)
}

function missing(name: string, expected: string): EnvError {
  return new EnvError([{ path: name, message: `is required (expected ${expected})` }])
}

function invalid(name: string, value: string, expected: string): EnvError {
  return new EnvError([{ path: name, message: `expected ${expected}, got ${show(name, value)}` }])
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on'])
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off', ''])

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
}

/**
 * Reads environment variables with parsing that fails loudly instead of guessing.
 *
 * Every method throws an `EnvError` naming the variable when it is absent with no fallback, or
 * present but unparseable. That is the whole point: JavaScript's built-in coercions are quietly
 * wrong in exactly the ways environment variables are quietly wrong.
 *
 * ```
 * Boolean('false')   // true   — DEBUG=false turns debugging on
 * Number('')         // 0      — an unset PORT becomes port 0
 * parseInt('12abc')  // 12     — a typo'd value is silently truncated
 * ```
 */
export class EnvReader {
  private readonly source: Record<string, string | undefined>

  constructor(source?: Record<string, string | undefined>) {
    this.source = source ?? (Bun.env as Record<string, string | undefined>)
  }

  /** True when the variable is set to a non-empty value. */
  has(name: string): boolean {
    const value = this.source[name]
    return value !== undefined && value !== ''
  }

  /** The unparsed value, or `undefined`. Nothing is trimmed or interpreted. */
  raw(name: string): string | undefined {
    return this.source[name]
  }

  /** Reads a string. Whitespace is trimmed, because trailing spaces in a `.env` are invisible. */
  string(name: string, fallback?: string): string {
    const value = this.source[name]?.trim()
    if (value === undefined || value === '') {
      if (fallback !== undefined) return fallback
      throw missing(name, 'a non-empty string')
    }
    return value
  }

  /** Reads a string, or `undefined` when unset. Never throws. */
  optional(name: string): string | undefined {
    const value = this.source[name]?.trim()
    return value === undefined || value === '' ? undefined : value
  }

  /**
   * Reads a number.
   *
   * Rejects anything `Number()` would silently mangle — an empty value is not zero, and
   * `12abc` is not 12.
   */
  number(name: string, fallback?: number): number {
    const raw = this.source[name]?.trim()
    if (raw === undefined || raw === '') {
      if (fallback !== undefined) return fallback
      throw missing(name, 'a number')
    }

    const value = Number(raw)
    if (!Number.isFinite(value)) throw invalid(name, raw, 'a number')
    return value
  }

  /** Reads an integer. A fractional value is rejected rather than rounded. */
  int(name: string, fallback?: number): number {
    const value = this.number(name, fallback)
    if (!Number.isInteger(value)) {
      throw invalid(name, this.source[name] ?? String(value), 'an integer')
    }
    return value
  }

  /**
   * Reads a boolean from `true/false`, `1/0`, `yes/no`, `y/n`, `on/off`.
   *
   * Anything else throws. Treating an unrecognised value as truthy is how `DEBUG=flase` ends up
   * enabling debug output in production, with no error anywhere to explain it.
   */
  bool(name: string, fallback?: boolean): boolean {
    const raw = this.source[name]?.trim().toLowerCase()
    if (raw === undefined) {
      if (fallback !== undefined) return fallback
      throw missing(name, 'a boolean')
    }

    if (TRUE_VALUES.has(raw)) return true
    if (FALSE_VALUES.has(raw)) return raw === '' && fallback !== undefined ? fallback : false

    throw invalid(name, raw, 'a boolean (true/false, 1/0, yes/no, on/off)')
  }

  /** Reads a TCP port, rejecting anything outside 1–65535. */
  port(name: string, fallback?: number): number {
    const value = this.int(name, fallback)
    if (value < 1 || value > 65_535) {
      throw invalid(name, String(value), 'a port between 1 and 65535')
    }
    return value
  }

  /** Reads a URL, rejecting one that will not parse. */
  url(name: string, fallback?: string): string {
    const value = this.string(name, fallback)
    try {
      new URL(value)
    } catch {
      throw invalid(name, value, 'a valid URL')
    }
    return value
  }

  /** Reads a comma-separated list. Empty entries are dropped, entries are trimmed. */
  list(name: string, fallback?: string[]): string[] {
    const raw = this.source[name]?.trim()
    if (raw === undefined || raw === '') {
      if (fallback !== undefined) return fallback
      throw missing(name, 'a comma-separated list')
    }
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
  }

  /** Reads one of a fixed set of values, naming the alternatives when it does not match. */
  oneOf<const Values extends readonly string[]>(
    name: string,
    values: Values,
    fallback?: Values[number],
  ): Values[number] {
    const raw = this.source[name]?.trim()
    if (raw === undefined || raw === '') {
      if (fallback !== undefined) return fallback
      throw missing(name, `one of ${values.join(', ')}`)
    }
    if (!values.includes(raw)) throw invalid(name, raw, `one of ${values.join(', ')}`)
    return raw as Values[number]
  }

  /**
   * Reads a duration in milliseconds.
   *
   * Accepts `30s`, `5m`, `1h`, `2d`, `500ms`, or a bare number of milliseconds. A unit is worth
   * supporting because `TIMEOUT=30` is ambiguous in a way `TIMEOUT=30s` is not.
   */
  duration(name: string, fallback?: number | string): number {
    const raw = this.source[name]?.trim().toLowerCase()
    if (raw === undefined || raw === '') {
      if (fallback === undefined) throw missing(name, 'a duration such as 30s')
      return typeof fallback === 'number' ? fallback : parseUnit(name, fallback, DURATION_UNITS)
    }
    return parseUnit(name, raw, DURATION_UNITS)
  }

  /**
   * Reads a size in bytes.
   *
   * Accepts `8mb`, `512kb`, `1gb`, or a bare number of bytes. Units are binary (1 kb = 1024 b),
   * which is what every size limit in this framework means.
   */
  bytes(name: string, fallback?: number | string): number {
    const raw = this.source[name]?.trim().toLowerCase()
    if (raw === undefined || raw === '') {
      if (fallback === undefined) throw missing(name, 'a size such as 8mb')
      return typeof fallback === 'number' ? fallback : parseUnit(name, fallback, BYTE_UNITS)
    }
    return parseUnit(name, raw, BYTE_UNITS)
  }

  /** The value of `NODE_ENV`, defaulting to `development`. */
  get nodeEnv(): string {
    return this.source.NODE_ENV?.trim() || 'development'
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production'
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development'
  }

  get isTest(): boolean {
    return this.nodeEnv === 'test'
  }

  /**
   * Every variable, with secret-looking values redacted.
   *
   * Redacted by default rather than on request, because the reason anyone dumps the environment
   * is to put it somewhere they can read it later — a log, an error report, a support ticket.
   */
  all(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [name, value] of Object.entries(this.source)) {
      if (value === undefined) continue
      result[name] = isSecretName(name) ? '[redacted]' : value
    }
    return result
  }
}

/** Parses `30s` or `8mb` against a unit table. */
function parseUnit(name: string, raw: string, units: Record<string, number>): number {
  const match = /^(-?\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(raw)
  if (!match) {
    throw invalid(name, raw, `a value with an optional unit (${Object.keys(units).join(', ')})`)
  }

  const amount = Number(match[1])
  const unit = match[2] ?? ''

  if (!Number.isFinite(amount)) throw invalid(name, raw, 'a number')
  if (unit === '') return amount

  const multiplier = units[unit]
  if (multiplier === undefined) {
    throw invalid(name, raw, `a known unit (${Object.keys(units).join(', ')})`)
  }
  return amount * multiplier
}

/** Builds a reader over a specific source. Tests use this; applications use `env`. */
export function createEnvReader(source: Record<string, string | undefined>): EnvReader {
  return new EnvReader(source)
}

/**
 * The process environment, read safely.
 *
 * ```ts
 * import { env } from '@theoven/core'
 *
 * const port = env.port('PORT', 3000)
 * const debug = env.bool('DEBUG', false)
 * const origins = env.list('ALLOWED_ORIGINS', [])
 * const timeout = env.duration('REQUEST_TIMEOUT', '30s')
 * const dbUrl = env.url('DATABASE_URL')          // throws if unset
 * ```
 */
export const env = new EnvReader()
