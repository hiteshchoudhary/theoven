import type { HttpMethod, RouteMatch, RouteParams } from './types'

/**
 * A node in the routing trie. One node per path segment.
 *
 * Children are split three ways so lookup can honour precedence without scanning:
 * a `Map` for static segments (O(1)), a single optional parameter child, and a single optional
 * wildcard child. Static wins over parameter, parameter wins over wildcard — always.
 */
interface Node<T> {
  /** Literal segment children, keyed by the segment text. */
  static: Map<string, Node<T>> | null
  /** `:name` child. At most one per node; the name is fixed at insert time. */
  param: Node<T> | null
  paramName: string
  /** `*name` child, which swallows the remainder of the path. Terminal by definition. */
  wildcard: Node<T> | null
  wildcardName: string
  /** Payloads registered on this exact path, keyed by method. */
  handlers: Map<HttpMethod, T> | null
}

function createNode<T>(): Node<T> {
  return {
    static: null,
    param: null,
    paramName: '',
    wildcard: null,
    wildcardName: '',
    handlers: null,
  }
}

const EMPTY_PARAMS: RouteParams = Object.freeze({})

/** Thrown at registration time — never at request time — when two routes cannot coexist. */
export class RouteConflictError extends Error {
  override name = 'RouteConflictError'
}

/**
 * Normalises a path for both insertion and lookup so that `/users`, `/users/`, and `users`
 * are the same route.
 *
 * We do *not* normalise case: paths are case-sensitive, as URLs are defined to be. We do not
 * collapse `//` either — an empty segment is a genuinely different (and almost always wrong)
 * path, and silently healing it hides bugs in whatever generated the URL.
 */
export function normalisePath(path: string): string {
  if (path.length === 0) return '/'
  let out = path.charCodeAt(0) === 47 ? path : `/${path}`
  // Strip a single trailing slash, but never turn "/" into "".
  if (out.length > 1 && out.charCodeAt(out.length - 1) === 47) {
    out = out.slice(0, -1)
  }
  return out
}

/** Percent-decoding is skipped entirely unless the segment actually needs it. */
function decodeSegment(segment: string): string {
  if (segment.indexOf('%') === -1) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    // A malformed escape is not worth throwing over; the raw value is more useful than a 500.
    return segment
  }
}

/**
 * Oven's router: a segment trie with backtracking.
 *
 * Backtracking matters more than it first appears. Given `/files/public/list` and
 * `/files/:id/download`, a request for `/files/public/download` must fall back to the
 * parameter branch after the static branch dead-ends. Routers that greedily commit to a static
 * match get this wrong, and it shows up as a baffling 404 in production.
 *
 * The payload type is generic because the router has no opinion about what a route *is* —
 * the server layer stores compiled handlers here, and tests store strings.
 */
export class Router<T> {
  private readonly root: Node<T> = createNode<T>()
  /** Registered patterns, for diagnostics and `oven routes`. */
  private readonly registered: Array<{ method: HttpMethod; pattern: string }> = []

  /**
   * Registers `payload` for `method` at `pattern`.
   *
   * Patterns use `:name` for a single segment and `*name` for a trailing catch-all. The
   * file-based routing layer translates `[id]` and `[...path]` into these before calling here.
   *
   * @throws {RouteConflictError} on a duplicate route, a wildcard that is not the final
   * segment, or two parameters sharing a position under different names.
   */
  insert(method: HttpMethod, pattern: string, payload: T): void {
    const path = normalisePath(pattern)
    let node = this.root

    if (path !== '/') {
      const segments = path.slice(1).split('/')
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i] as string
        const isLast = i === segments.length - 1

        if (segment.charCodeAt(0) === 42 /* * */) {
          if (!isLast) {
            throw new RouteConflictError(
              `Wildcard must be the final segment: "${pattern}" has "${segment}" followed by more path.`,
            )
          }
          const name = segment.slice(1) || '*'
          node = this.claimWildcard(node, name, pattern)
        } else if (segment.charCodeAt(0) === 58 /* : */) {
          const name = segment.slice(1)
          if (name.length === 0) {
            throw new RouteConflictError(`Unnamed parameter in "${pattern}". Use ":name".`)
          }
          node = this.claimParam(node, name, pattern)
        } else {
          node.static ??= new Map()
          let child = node.static.get(segment)
          if (child === undefined) {
            child = createNode<T>()
            node.static.set(segment, child)
          }
          node = child
        }
      }
    }

    node.handlers ??= new Map()
    if (node.handlers.has(method)) {
      throw new RouteConflictError(`Duplicate route: ${method} ${path} is already registered.`)
    }
    node.handlers.set(method, payload)
    this.registered.push({ method, pattern: path })
  }

  private claimParam(node: Node<T>, name: string, pattern: string): Node<T> {
    if (node.param === null) {
      node.param = createNode<T>()
      node.paramName = name
      return node.param
    }
    if (node.paramName !== name) {
      // Allowing this would mean the same position yields a different key depending on which
      // route matched — a genuinely confusing bug to debug at 3am.
      throw new RouteConflictError(
        `Parameter name conflict in "${pattern}": this position is already registered as ` +
          `":${node.paramName}", cannot also be ":${name}". Use one name consistently.`,
      )
    }
    return node.param
  }

  private claimWildcard(node: Node<T>, name: string, pattern: string): Node<T> {
    if (node.wildcard === null) {
      node.wildcard = createNode<T>()
      node.wildcardName = name
      return node.wildcard
    }
    if (node.wildcardName !== name) {
      throw new RouteConflictError(
        `Wildcard name conflict in "${pattern}": this position is already registered as ` +
          `"*${node.wildcardName}", cannot also be "*${name}".`,
      )
    }
    return node.wildcard
  }

  /**
   * Scratch space reused across lookups.
   *
   * `walk` is fully synchronous, so a lookup can never interleave with another one and these
   * can be shared safely. This is what keeps a static-route hit down to a single allocation
   * (the result object) instead of four.
   */
  private readonly names: string[] = []
  private readonly values: string[] = []
  private readonly allowed: HttpMethod[] = []
  private depth = 0

  /**
   * Looks up a route.
   *
   * A hit on a static route allocates only the returned object and reuses a frozen empty params
   * object. Parameters are collected into reusable stacks and only materialised into an object
   * once a match is confirmed, so failed branches cost nothing.
   */
  find(method: HttpMethod, path: string): RouteMatch<T> {
    const normalised = normalisePath(path)
    this.depth = 0
    this.allowed.length = 0

    const payload = this.walk(this.root, normalised, 1, method)

    if (payload !== undefined) {
      const depth = this.depth
      if (depth === 0) return { found: true, payload, params: EMPTY_PARAMS }
      const params: RouteParams = {}
      for (let i = 0; i < depth; i++) {
        params[this.names[i] as string] = this.values[i] as string
      }
      return { found: true, payload, params }
    }

    return { found: false, allowed: this.allowed.length === 0 ? [] : [...this.allowed] }
  }

  /** Records a method for the `Allow` header, keeping the list unique without a Set. */
  private allow(handlers: Map<HttpMethod, T>): void {
    for (const method of handlers.keys()) {
      if (this.allowed.indexOf(method) === -1) this.allowed.push(method)
    }
  }

  private push(name: string, value: string): void {
    this.names[this.depth] = name
    this.values[this.depth] = value
    this.depth++
  }

  /**
   * Depth-first walk with backtracking.
   *
   * A branch that fails rewinds `depth`, which discards whatever parameters it captured without
   * touching the underlying arrays.
   */
  private walk(node: Node<T>, path: string, start: number, method: HttpMethod): T | undefined {
    if (start >= path.length) {
      const handlers = node.handlers
      if (handlers !== null) {
        const payload = handlers.get(method)
        if (payload !== undefined) return payload
        this.allow(handlers)
      }
      // A wildcard can still match an empty remainder: "/files/*path" answers "/files".
      const wildcard = node.wildcard
      if (wildcard !== null && wildcard.handlers !== null) {
        const payload = wildcard.handlers.get(method)
        if (payload !== undefined) {
          this.push(node.wildcardName, '')
          return payload
        }
        this.allow(wildcard.handlers)
      }
      return undefined
    }

    let end = path.indexOf('/', start)
    if (end === -1) end = path.length
    const segment = path.slice(start, end)
    const next = end + 1

    // 1. Static — highest precedence.
    if (node.static !== null) {
      const child = node.static.get(segment)
      if (child !== undefined) {
        const payload = this.walk(child, path, next, method)
        if (payload !== undefined) return payload
      }
    }

    // 2. Parameter.
    if (node.param !== null) {
      const mark = this.depth
      this.push(node.paramName, decodeSegment(segment))
      const payload = this.walk(node.param, path, next, method)
      if (payload !== undefined) return payload
      this.depth = mark
    }

    // 3. Wildcard — swallows everything remaining, including slashes.
    const wildcard = node.wildcard
    if (wildcard !== null && wildcard.handlers !== null) {
      const payload = wildcard.handlers.get(method)
      if (payload !== undefined) {
        this.push(node.wildcardName, decodeSegment(path.slice(start)))
        return payload
      }
      this.allow(wildcard.handlers)
    }

    return undefined
  }

  /** Every registered route, in registration order. Used by `oven routes` and boot logging. */
  routes(): ReadonlyArray<{ method: HttpMethod; pattern: string }> {
    return this.registered
  }
}
