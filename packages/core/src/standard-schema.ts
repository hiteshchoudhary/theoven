/**
 * The Standard Schema v1 contract.
 *
 * Declared here rather than depended on. It is a type-only specification — Zod, Valibot,
 * ArkType and Effect all implement the same `~standard` property — so importing a package to
 * describe it would add a dependency to `@theoven/core` for zero runtime code.
 *
 * This is what keeps Oven honest about D4: Zod 4 is the bundled default because it can emit
 * JSON Schema natively, which is what makes OpenAPI generation free. It is not a requirement.
 *
 * @see https://standardschema.dev
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    /** Library that produced the schema — `zod`, `valibot`, and so on. */
    readonly vendor: string
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    /** Phantom property carrying the inferred types. Never present at runtime. */
    readonly types?: Types<Input, Output> | undefined
  }

  type Result<Output> = SuccessResult<Output> | FailureResult

  interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }

  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }

  interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }

  interface PathSegment {
    readonly key: PropertyKey
  }

  interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }

  type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input']

  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output']
}

/** True when a value implements the Standard Schema contract. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    '~standard' in value &&
    typeof (value as StandardSchemaV1)['~standard']?.validate === 'function'
  )
}

/**
 * Renders an issue path as a readable string.
 *
 * `["user", "emails", 0]` becomes `user.emails[0]` — the form someone can paste back into
 * their client code, rather than a JSON array they have to mentally reassemble.
 */
export function formatPath(path: StandardSchemaV1.Issue['path']): string {
  if (!path || path.length === 0) return ''

  let out = ''
  for (const segment of path) {
    const key = typeof segment === 'object' && segment !== null ? segment.key : segment
    if (typeof key === 'number') {
      out += `[${key}]`
    } else {
      out += out === '' ? String(key) : `.${String(key)}`
    }
  }
  return out
}
