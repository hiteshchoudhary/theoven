/**
 * Errors in Oven are values, not accidents.
 *
 * A handler signals a failure by throwing one of these, and the framework turns it into an
 * RFC 9457 `application/problem+json` response. Async throws are caught the same way as
 * synchronous ones — there is no `express-async-errors` equivalent to remember.
 *
 * Anything thrown that is *not* an `OvenError` is treated as a bug: it becomes a 500, and its
 * message and stack are withheld in production, because an unplanned error message is exactly
 * where connection strings and internal hostnames leak.
 */
export class OvenError extends Error {
  override name = 'OvenError'

  /** HTTP status this error maps to. */
  readonly status: number
  /** Short, human-readable summary. Becomes `title` in the problem document. */
  readonly title: string
  /** Machine-readable problem type URI. Stays `about:blank` unless a module defines one. */
  readonly type: string
  /** Extra members merged into the problem document — e.g. per-field validation detail. */
  readonly detail: Record<string, unknown> | undefined
  /** Headers this error requires on the response, e.g. `Allow` on a 405. */
  readonly headers: Record<string, string> | undefined

  constructor(
    status: number,
    title: string,
    message?: string,
    options?: {
      type?: string
      detail?: Record<string, unknown>
      headers?: Record<string, string>
      cause?: unknown
    },
  ) {
    super(message ?? title, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.status = status
    this.title = title
    this.type = options?.type ?? 'about:blank'
    this.detail = options?.detail
    this.headers = options?.headers
  }

  /**
   * Serialises to an RFC 9457 problem document.
   *
   * `message` is only included when it adds something beyond `title`, so the common
   * `throw new NotFound()` does not produce a document that says "Not Found" twice.
   */
  toProblem(): Record<string, unknown> {
    const problem: Record<string, unknown> = {
      type: this.type,
      title: this.title,
      status: this.status,
    }
    if (this.message && this.message !== this.title) problem.detail = this.message
    if (this.detail) Object.assign(problem, this.detail)
    return problem
  }
}

function defineError(status: number, name: string, title: string) {
  return class extends OvenError {
    override name = name
    constructor(message?: string, options?: ConstructorParameters<typeof OvenError>[3]) {
      super(status, title, message, options)
    }
  }
}

export const BadRequest = defineError(400, 'BadRequest', 'Bad Request')
export const Unauthorized = defineError(401, 'Unauthorized', 'Unauthorized')
export const Forbidden = defineError(403, 'Forbidden', 'Forbidden')
export const NotFound = defineError(404, 'NotFound', 'Not Found')
export const MethodNotAllowed = defineError(405, 'MethodNotAllowed', 'Method Not Allowed')
export const Conflict = defineError(409, 'Conflict', 'Conflict')
export const PayloadTooLarge = defineError(413, 'PayloadTooLarge', 'Payload Too Large')
export const UnsupportedMediaType = defineError(
  415,
  'UnsupportedMediaType',
  'Unsupported Media Type',
)
export const UnprocessableContent = defineError(
  422,
  'UnprocessableContent',
  'Unprocessable Content',
)
export const TooManyRequests = defineError(429, 'TooManyRequests', 'Too Many Requests')
export const InternalServerError = defineError(500, 'InternalServerError', 'Internal Server Error')
export const ServiceUnavailable = defineError(503, 'ServiceUnavailable', 'Service Unavailable')

/**
 * Converts anything thrown into an `OvenError`.
 *
 * Non-Oven errors keep their message only outside production. In production the caller sees a
 * bare 500 while the real error still reaches the logs — the operator gets the detail, the
 * internet does not.
 */
export function toOvenError(thrown: unknown, isProduction: boolean): OvenError {
  if (thrown instanceof OvenError) return thrown

  const message =
    !isProduction && thrown instanceof Error ? thrown.message : 'An unexpected error occurred.'

  return new OvenError(500, 'Internal Server Error', message, { cause: thrown })
}
