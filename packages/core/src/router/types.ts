/**
 * HTTP methods Oven routes can be registered for.
 *
 * There is deliberately no support for arbitrary/custom methods: every method here maps to a
 * well-defined semantic in RFC 9110, and a router that accepts anything cannot warn you about
 * a typo'd `"POTS"`.
 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]

const METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS)

export function isHttpMethod(value: string): value is HttpMethod {
  return METHOD_SET.has(value)
}

/** Path parameters extracted from a matched route. */
export type RouteParams = Record<string, string>

/**
 * Outcome of a router lookup.
 *
 * A miss carries the methods that *are* registered on the matched path, which is what lets the
 * server answer `405 Method Not Allowed` with a correct `Allow` header instead of a lazy 404.
 * An empty `allowed` array means no route matched the path at all.
 */
export type RouteMatch<T> =
  | { found: true; payload: T; params: RouteParams }
  | { found: false; allowed: HttpMethod[] }
