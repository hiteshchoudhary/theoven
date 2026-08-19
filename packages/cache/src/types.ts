/**
 * The cache contract.
 *
 * Small, like the database one: get, set, delete, and delete-by-tag. Everything interesting —
 * stampede protection, the `cached()` helper, tag bookkeeping — lives above this, so it behaves
 * identically whether the entries are in memory or in Redis.
 */

export interface CacheEntry<Value = unknown> {
  value: Value
  /** Epoch milliseconds. `undefined` means it does not expire on its own. */
  expiresAt?: number | undefined
}

export interface SetOptions {
  /** Time to live in milliseconds. Omit for no expiry. */
  ttl?: number | undefined
  /**
   * Tags this entry belongs to, for invalidating a group at once.
   *
   * `['user:42']` on everything derived from that user means one `invalidate('user:42')` clears
   * all of it — which is what you actually want, rather than remembering every key you wrote.
   */
  tags?: readonly string[] | undefined
}

export interface CacheDriver {
  /** Identifies the driver in logs and errors, e.g. `memory` or `redis`. */
  readonly name: string

  start?(): Promise<void> | void

  get(key: string): Promise<CacheEntry | undefined>
  set(key: string, entry: CacheEntry, options: SetOptions): Promise<void>
  delete(key: string): Promise<void>
  /** Removes every entry carrying the tag. Returns how many were removed. */
  invalidate(tag: string): Promise<number>
  clear(): Promise<void>

  close?(): Promise<void> | void

  /** The underlying client, for whatever the contract does not cover. */
  readonly raw: unknown
}

export class CacheError extends Error {
  override name = 'CacheError'
  readonly driver: string | undefined

  constructor(message: string, options: { driver?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.driver = options.driver
  }
}
