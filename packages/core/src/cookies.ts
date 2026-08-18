/**
 * Cookie reading and writing.
 *
 * Always available on `ctx.cookies` — there is no `cookieParser()` to install and no order to
 * get wrong. Parsing is lazy: the `Cookie` header is only split when something asks for a value.
 *
 * Defaults lean secure. `httpOnly` and `sameSite: 'lax'` are on unless you opt out, and
 * `secure` is on outside development. The common case of `cookies.set('session', id)` should
 * produce a cookie you would be happy to ship, not one you have to remember to harden.
 */

export interface CookieOptions {
  domain?: string
  path?: string
  /** Absolute expiry. Prefer `maxAge` unless you specifically need a date. */
  expires?: Date
  /** Lifetime in seconds. */
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
  /** Sign the value so tampering is detectable. Requires a configured secret. */
  signed?: boolean
  partitioned?: boolean
}

export interface CookieJarInit {
  /** Secret for signed cookies. Without it, signing throws rather than silently not signing. */
  secret?: string | undefined
  /** Applies `secure` by default. Normally `NODE_ENV === 'production'`. */
  secureByDefault?: boolean
}

/**
 * Constant-time string comparison.
 *
 * A signature check that returns early on the first mismatched byte leaks, through timing, how
 * much of a forged signature was correct — which is enough to forge the rest one byte at a
 * time. Comparing every byte regardless costs nothing here.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

function sign(value: string, secret: string): string {
  return new Bun.CryptoHasher('sha256', secret).update(value).digest('base64url')
}

/** Splits a `Cookie` header. Malformed pairs are skipped rather than failing the whole header. */
function parseCookieHeader(header: string): Map<string, string> {
  const jar = new Map<string, string>()

  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue

    const name = part.slice(0, eq).trim()
    if (name === '') continue

    let value = part.slice(eq + 1).trim()
    if (value.charCodeAt(0) === 34 /* " */ && value.charCodeAt(value.length - 1) === 34) {
      value = value.slice(1, -1)
    }

    try {
      jar.set(name, decodeURIComponent(value))
    } catch {
      jar.set(name, value)
    }
  }

  return jar
}

function serialise(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]

  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.domain) parts.push(`Domain=${options.domain}`)
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  parts.push(`SameSite=${capitalise(options.sameSite ?? 'lax')}`)
  if (options.partitioned) parts.push('Partitioned')

  return parts.join('; ')
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export class Cookies {
  private readonly header: string | null
  private readonly init: CookieJarInit
  /** Callback that appends a `Set-Cookie` header to the response. */
  private readonly emit: (value: string) => void
  private parsed: Map<string, string> | undefined

  constructor(header: string | null, emit: (value: string) => void, init: CookieJarInit = {}) {
    this.header = header
    this.emit = emit
    this.init = init
  }

  /** Lazily splits the header. A request whose cookies are never read never pays for parsing. */
  private get jar(): Map<string, string> {
    if (this.parsed === undefined) {
      this.parsed = this.header ? parseCookieHeader(this.header) : new Map()
    }
    return this.parsed
  }

  /**
   * Reads a cookie.
   *
   * A signed cookie whose signature does not verify reads as `undefined` — the same as absent.
   * Returning the tampered value with a flag would invite callers to use it by mistake.
   */
  get(name: string, options: { signed?: boolean } = {}): string | undefined {
    const raw = this.jar.get(name)
    if (raw === undefined) return undefined
    if (!options.signed) return raw

    const secret = this.requireSecret()
    const dot = raw.lastIndexOf('.')
    if (dot < 1) return undefined

    const value = raw.slice(0, dot)
    const signature = raw.slice(dot + 1)
    return timingSafeEqual(signature, sign(value, secret)) ? value : undefined
  }

  /** True if the cookie is present, regardless of whether its signature verifies. */
  has(name: string): boolean {
    return this.jar.has(name)
  }

  /** Every cookie on the request, unsigned and unverified. */
  all(): Record<string, string> {
    return Object.fromEntries(this.jar)
  }

  /** Sets a cookie on the response. Chainable. */
  set(name: string, value: string, options: CookieOptions = {}): this {
    const stored = options.signed ? `${value}.${sign(value, this.requireSecret())}` : value

    const resolved: CookieOptions = {
      ...options,
      secure: options.secure ?? this.init.secureByDefault ?? false,
    }

    // `SameSite=None` without `Secure` is rejected by every current browser, so the cookie
    // would be dropped silently. Fixing it beats shipping a cookie that never arrives.
    if (resolved.sameSite === 'none') resolved.secure = true

    this.emit(serialise(name, stored, resolved))
    return this
  }

  /**
   * Deletes a cookie.
   *
   * Path and domain must match the cookie that was set, or the browser treats it as a different
   * cookie and leaves the original in place — the most common reason "logout does not work".
   */
  delete(name: string, options: Pick<CookieOptions, 'path' | 'domain'> = {}): this {
    this.emit(
      serialise(name, '', {
        ...options,
        maxAge: 0,
        expires: new Date(0),
        secure: this.init.secureByDefault ?? false,
      }),
    )
    return this
  }

  private requireSecret(): string {
    const secret = this.init.secret
    if (!secret) {
      throw new Error(
        'Signed cookies need a secret. Pass one to createApp({ cookies: { secret } }).',
      )
    }
    return secret
  }
}
