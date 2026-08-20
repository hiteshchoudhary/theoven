import type { BodyInit } from 'bun'

const JSON_TYPE = 'application/json; charset=utf-8'
const TEXT_TYPE = 'text/plain; charset=utf-8'
const BINARY_TYPE = 'application/octet-stream'

/** Statuses that RFC 9110 forbids from carrying a body. Sending one throws in Bun. */
const BODILESS = new Set([101, 204, 205, 304])

/**
 * Whether a handler took control of the response rather than returning a value to serialise.
 *
 * A `response` schema describes the JSON body a handler would otherwise have returned. It has
 * nothing to say about a stream, a file or a `Response` the handler built itself — and checking
 * one against it turned a working route into a 500, because a `Response` object has none of the
 * fields the schema asks for.
 *
 * Strings are deliberately **not** here: `response: { 200: z.string() }` is a reasonable contract
 * for a text endpoint, and validating it costs nothing.
 *
 * Kept beside `toResponse` so the two lists cannot drift: every branch below that bypasses JSON
 * serialisation is a branch a schema cannot describe.
 */
export function tookControl(value: unknown): boolean {
  return (
    value instanceof Response ||
    value instanceof Blob ||
    value instanceof ReadableStream ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof URL
  )
}

/**
 * Turns whatever a handler returned into a `Response`.
 *
 * Handlers are not required to know about HTTP. Returning an object should mean JSON, returning
 * a string should mean text, and returning nothing should mean "204, we are done". The rules
 * below are ordered from most specific to least, and the fallback is JSON because that is what
 * an API returns nine times out of ten.
 *
 * @param value  whatever the handler returned
 * @param status status the context asked for, or `undefined` to let the value decide
 * @param headers response headers accumulated on the context, if any
 */
export function toResponse(
  value: unknown,
  status: number | undefined,
  headers: Headers | undefined,
): Response {
  // 1. A Response passes through untouched. The handler took full control on purpose, so we
  //    only fill in headers it did not already set — never overwrite its decisions.
  if (value instanceof Response) {
    if (headers) {
      for (const [name, headerValue] of headers) {
        if (!value.headers.has(name)) value.headers.set(name, headerValue)
      }
    }
    return value
  }

  // 2. Nothing returned means nothing to say. 204 unless the handler set a status itself,
  //    which is how `ctx.status = 201; return null` produces a bodiless 201.
  if (value === null || value === undefined) {
    return new Response(null, init(status ?? 204, headers))
  }

  const resolved = status ?? 200

  // A body would be illegal at this status, so drop it rather than throw.
  if (BODILESS.has(resolved)) {
    return new Response(null, init(resolved, headers))
  }

  if (typeof value === 'string') {
    return build(value, resolved, headers, TEXT_TYPE)
  }

  // 3. Blob covers File and Bun.file() alike; Bun streams these from disk without buffering
  //    and derives Content-Type from the file itself.
  if (value instanceof Blob) {
    return build(value, resolved, headers, value.type || BINARY_TYPE)
  }

  if (value instanceof ReadableStream) {
    return build(value, resolved, headers, BINARY_TYPE)
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return build(value as BodyInit, resolved, headers, BINARY_TYPE)
  }

  if (value instanceof URL) {
    const location = new Headers(headers)
    location.set('location', value.href)
    return new Response(null, { status: status ?? 302, headers: location })
  }

  // 4. Everything else is JSON: objects, arrays, numbers, booleans. `return 42` is a valid
  //    JSON document, so it needs no special case.
  return build(JSON.stringify(value), resolved, headers, JSON_TYPE)
}

/**
 * Builds a `ResponseInit`, omitting `headers` entirely when there are none.
 *
 * Passing `headers: undefined` explicitly is a type error under `exactOptionalPropertyTypes`,
 * and omitting the key is what we mean anyway.
 */
function init(status: number, headers: Headers | undefined): ResponseInit {
  return headers ? { status, headers } : { status }
}

/**
 * Builds the response, applying `contentType` only as a default.
 *
 * A handler that set `ctx.set('content-type', ...)` meant it — for instance returning a string
 * of pre-rendered HTML — so an explicit content type always wins.
 */
function build(
  body: BodyInit,
  status: number,
  headers: Headers | undefined,
  contentType: string,
): Response {
  // The overwhelmingly common case: the handler set no headers of its own. A plain object
  // literal lets the runtime build the header list directly and skips allocating a Headers
  // instance we would immediately throw away.
  if (headers === undefined) {
    return new Response(body, { status, headers: { 'content-type': contentType } })
  }

  const finalHeaders = new Headers(headers)
  if (!finalHeaders.has('content-type')) finalHeaders.set('content-type', contentType)
  return new Response(body, { status, headers: finalHeaders })
}
