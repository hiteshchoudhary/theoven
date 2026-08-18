import { BadRequest, PayloadTooLarge, UnsupportedMediaType } from './errors'
import { parseQuery, type QueryOptions } from './query'

/**
 * Request body parsing.
 *
 * Always available, never installed, and — the part that matters — **lazy**. A route that
 * returns a constant never touches the body, so it never allocates a buffer, never runs
 * `JSON.parse`, and never waits on the stream. Batteries included is worthless if you pay for
 * batteries you do not use.
 *
 * Parsing is chosen by `Content-Type`:
 *
 *   | Content-Type                        | You get                            |
 *   | ----------------------------------- | ---------------------------------- |
 *   | `application/json`, `+json`         | the parsed value                   |
 *   | `application/x-www-form-urlencoded` | an object, nesting and arrays kept |
 *   | `multipart/form-data`               | an object, files as `File`         |
 *   | `text/*`                            | a string                           |
 *   | anything else                       | an `ArrayBuffer`                   |
 *
 * An empty body is `undefined`, not a throw. `GET` with no body is the most common request
 * there is, and it should not need a guard.
 */

export interface BodyOptions {
  /** Largest body accepted, in bytes. Default 8 MB. */
  limit?: number
  /** Per-file cap for multipart uploads, in bytes. Defaults to `limit`. */
  fileLimit?: number
  /** Maximum files in one multipart request. Default 20. */
  maxFiles?: number
  /** MIME allowlist for uploads. Entries may be exact (`image/png`) or a prefix (`image/*`). */
  allowedFileTypes?: string[]
  /** Nesting and key limits for urlencoded bodies. */
  query?: QueryOptions
}

const DEFAULT_LIMIT = 8 * 1024 * 1024
const DEFAULT_MAX_FILES = 20

/** Strips parameters: `application/json; charset=utf-8` becomes `application/json`. */
function mediaType(header: string | null): string {
  if (!header) return ''
  const semicolon = header.indexOf(';')
  return (semicolon === -1 ? header : header.slice(0, semicolon)).trim().toLowerCase()
}

function isJson(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json')
}

/**
 * Reads the body while counting bytes, so the limit holds even when `Content-Length` lies or is
 * absent.
 *
 * Checking the header alone is the mistake worth avoiding here: it is trivially spoofable, and
 * chunked requests do not carry one at all. Counting as we read means a hostile client cannot
 * stream us out of memory by simply omitting a header.
 */
async function readLimited(request: Request, limit: number): Promise<ArrayBuffer> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    // Reject before reading a byte when the client is honest about being too large.
    if (Number.isFinite(length) && length > limit) {
      throw new PayloadTooLarge(`Body exceeds the ${limit} byte limit.`)
    }
  }

  const stream = request.body
  if (!stream) return new ArrayBuffer(0)

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        // Stop pulling immediately; there is no reason to finish receiving a body we reject.
        await reader.cancel()
        throw new PayloadTooLarge(`Body exceeds the ${limit} byte limit.`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged.buffer
}

function decode(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer)
}

/** Matches `image/png` against `image/png` or `image/*`. */
function typeAllowed(type: string, allowed: string[]): boolean {
  return allowed.some((pattern) => {
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1))
    return pattern.toLowerCase() === type
  })
}

function checkFile(file: File, options: BodyOptions, limit: number): void {
  const fileLimit = options.fileLimit ?? limit
  if (file.size > fileLimit) {
    throw new PayloadTooLarge(`"${file.name}" exceeds the ${fileLimit} byte per-file limit.`)
  }

  if (options.allowedFileTypes && !typeAllowed(file.type.toLowerCase(), options.allowedFileTypes)) {
    throw new UnsupportedMediaType(
      `"${file.name}" is ${file.type || 'of unknown type'}, which is not accepted here.`,
    )
  }
}

/** A parsed multipart or urlencoded body. Repeated field names collapse into arrays. */
export type FormBody = Record<string, string | File | Array<string | File>>

/**
 * Whatever `Request.formData()` actually resolves to in this runtime.
 *
 * Taken from the method rather than the global `FormData`: without lib.dom the global resolves
 * to a different declaration, and the two are not assignable to each other.
 */
type RequestFormData = Awaited<ReturnType<Request['formData']>>

function collect(form: RequestFormData, options: BodyOptions, limit: number): FormBody {
  const result: FormBody = {}
  let fileCount = 0
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES

  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      if (++fileCount > maxFiles) {
        throw new PayloadTooLarge(`More than ${maxFiles} files in one request.`)
      }
      checkFile(value, options, limit)
    }

    const existing = result[key]
    if (existing === undefined) result[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else result[key] = [existing, value]
  }

  return result
}

/**
 * Parses a request body according to its `Content-Type`.
 *
 * @param request the incoming request
 * @param options limits and allowlists
 * @param raw     pre-read bytes, when `ctx.rawBody` already consumed the stream
 */
export async function parseBody(
  request: Request,
  options: BodyOptions = {},
  raw?: ArrayBuffer,
): Promise<unknown> {
  const limit = options.limit ?? DEFAULT_LIMIT
  const type = mediaType(request.headers.get('content-type'))

  // Multipart is the one case worth streaming rather than buffering: uploads are large by
  // definition, and Bun's FormData spills big parts to temporary files instead of holding them
  // in memory. Buffering first would defeat that entirely.
  if (type === 'multipart/form-data' && raw === undefined) {
    const declared = request.headers.get('content-length')
    if (declared !== null && Number(declared) > limit) {
      throw new PayloadTooLarge(`Body exceeds the ${limit} byte limit.`)
    }
    try {
      return collect(await request.formData(), options, limit)
    } catch (thrown) {
      if (thrown instanceof PayloadTooLarge || thrown instanceof UnsupportedMediaType) throw thrown
      throw new BadRequest('Malformed multipart body.', { cause: thrown })
    }
  }

  const buffer = raw ?? (await readLimited(request, limit))
  if (buffer.byteLength === 0) return undefined

  if (isJson(type)) {
    const text = decode(buffer)
    try {
      return JSON.parse(text)
    } catch (thrown) {
      // The parser's own message ("Unexpected token } in JSON at position 42") is genuinely
      // useful to whoever is debugging the client, and reveals nothing about the server.
      const detail = thrown instanceof Error ? thrown.message : 'Invalid JSON'
      throw new BadRequest(`Could not parse JSON body: ${detail}`)
    }
  }

  if (type === 'application/x-www-form-urlencoded') {
    return parseQuery(decode(buffer), options.query)
  }

  if (type === 'multipart/form-data') {
    // Reached only when rawBody was read first, so the stream is gone and we must reconstruct.
    try {
      const rebuilt = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: buffer,
      })
      return collect(await rebuilt.formData(), options, limit)
    } catch (thrown) {
      throw new BadRequest('Malformed multipart body.', { cause: thrown })
    }
  }

  if (type.startsWith('text/')) return decode(buffer)

  // Unknown types stay bytes. Guessing at a parse would be worse than handing back exactly
  // what arrived — a webhook with a bespoke content type still needs its payload intact.
  return buffer
}

/** Reads the body as raw bytes, enforcing the size limit. Used for webhook signature checks. */
export function readRaw(request: Request, options: BodyOptions = {}): Promise<ArrayBuffer> {
  return readLimited(request, options.limit ?? DEFAULT_LIMIT)
}

/** Extracts just the `File` entries from a parsed form body, always as arrays. */
export function filesOf(body: unknown): Record<string, File[]> {
  const files: Record<string, File[]> = {}
  if (typeof body !== 'object' || body === null) return files

  for (const [key, value] of Object.entries(body)) {
    if (value instanceof File) files[key] = [value]
    else if (Array.isArray(value)) {
      const only = value.filter((entry): entry is File => entry instanceof File)
      if (only.length > 0) files[key] = only
    }
  }

  return files
}
