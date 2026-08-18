import { formatPath, type StandardSchemaV1 } from './standard-schema'

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
