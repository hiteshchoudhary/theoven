/**
 * Query string parsing.
 *
 * `URLSearchParams` is the web standard and Oven uses it underneath, but it flattens everything
 * to strings and keeps only the first value per key. Real APIs receive `?tag=a&tag=b` and
 * `?filter[status]=open`, and every Express app in existence reached for `qs` to handle them.
 * That is core behaviour here.
 *
 * Two limits are enforced, and both exist because this parser reads attacker-controlled input:
 *
 *   - **Depth.** `a[b][c][d]...` nested a thousand levels deep builds a thousand objects from a
 *     few hundred bytes. Beyond the limit, the remaining brackets are treated as a literal key.
 *   - **Key count.** A query string with 100,000 parameters is a cheap way to burn CPU.
 *
 * Prototype pollution is blocked outright rather than limited: `__proto__`, `constructor` and
 * `prototype` are dropped wherever they appear as a key. This is the `qs` CVE class, and the
 * only safe amount of it is none.
 */

export interface QueryOptions {
  /** Maximum bracket nesting. Deeper keys are kept verbatim rather than expanded. Default 5. */
  depth?: number
  /** Maximum number of parameters parsed. Extras are ignored. Default 1000. */
  maxKeys?: number
}

/** Values a parsed query can hold. Nested objects and arrays are produced by bracket syntax. */
export type QueryValue = string | QueryValue[] | { [key: string]: QueryValue }
export type ParsedQuery = Record<string, QueryValue>

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

const DEFAULT_DEPTH = 5
const DEFAULT_MAX_KEYS = 1000

/**
 * Splits `a[b][c]` into `['a', 'b', 'c']`, and `a[]` into `['a', '']`.
 *
 * Anything past `depth` is left attached to the last segment, so a hostile key stops costing
 * us objects without silently losing data.
 */
function splitKey(key: string, depth: number): string[] {
  const bracket = key.indexOf('[')
  if (bracket === -1) return [key]

  const segments: string[] = [key.slice(0, bracket)]
  let index = bracket

  while (index < key.length && segments.length <= depth) {
    if (key.charCodeAt(index) !== 91 /* [ */) break
    const close = key.indexOf(']', index)
    if (close === -1) break
    segments.push(key.slice(index + 1, close))
    index = close + 1
  }

  // Trailing junk, or nesting past the depth limit, becomes part of the final segment.
  if (index < key.length) {
    segments[segments.length - 1] += key.slice(index)
  }

  return segments
}

/** Appends to an existing value, promoting a scalar to an array on the second occurrence. */
function append(existing: QueryValue | undefined, value: QueryValue): QueryValue {
  if (existing === undefined) return value
  if (Array.isArray(existing)) {
    existing.push(value)
    return existing
  }
  return [existing, value]
}

function assign(target: ParsedQuery, segments: string[], value: string): void {
  if (segments.some((segment) => FORBIDDEN.has(segment))) return

  const [head, ...rest] = segments
  if (head === undefined || head === '') return

  if (rest.length === 0) {
    target[head] = append(target[head], value)
    return
  }

  // `a[]=1&a[]=2` — an explicit array push.
  if (rest.length === 1 && rest[0] === '') {
    const existing = target[head]
    if (Array.isArray(existing)) existing.push(value)
    else if (existing === undefined) target[head] = [value]
    else target[head] = [existing, value]
    return
  }

  // Nested object. A conflicting scalar is replaced: `?a=1&a[b]=2` is contradictory input, and
  // preferring the structured form loses less than throwing the whole query away.
  let container = target[head]
  if (container === undefined || typeof container === 'string' || Array.isArray(container)) {
    container = {}
    target[head] = container
  }

  assign(container as ParsedQuery, rest, value)
}

/**
 * Parses a query string into a structured object.
 *
 * Accepts the string with or without a leading `?`, or a `URLSearchParams`.
 */
export function parseQuery(
  input: string | URLSearchParams,
  options: QueryOptions = {},
): ParsedQuery {
  const depth = options.depth ?? DEFAULT_DEPTH
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS

  const params =
    typeof input === 'string'
      ? new URLSearchParams(input.charCodeAt(0) === 63 /* ? */ ? input.slice(1) : input)
      : input

  // Null-prototype so a key named `toString` cannot shadow anything inherited.
  const result: ParsedQuery = Object.create(null)

  let count = 0
  for (const [key, value] of params) {
    if (++count > maxKeys) break
    assign(result, splitKey(key, depth), value)
  }

  return result
}
