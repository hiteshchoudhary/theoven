/** What one check decided. */
export interface RateLimitResult {
  /** Requests counted in the window this request falls in, including this one. */
  count: number
  /** Milliseconds until the window this request was counted against rolls over. */
  resetMs: number
}

/**
 * Shared counting, behind one interface.
 *
 * The contract is a single method because the whole difficulty is that it must be **atomic**.
 * A store offering `get` and `set` separately cannot be used correctly: two instances read 99,
 * both write 100, and a limit of 100 admitted 101 requests. So the contract is "count this and
 * tell me the total", and every implementation owes that atomically.
 */
export interface RateLimitStore {
  name: string
  /**
   * Records one request against `key` and returns the running total.
   *
   * @param window window length in milliseconds
   */
  hit(key: string, window: number, now: number): Promise<RateLimitResult>
  close?(): Promise<void>
}
