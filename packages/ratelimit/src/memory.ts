import type { RateLimitResult, RateLimitStore } from './types'

export interface MemoryStoreOptions {
  /** Entries kept before the oldest windows are swept. */
  max?: number
}

/**
 * Counting in this process, using the same sliding window as the shared stores.
 *
 * Its purpose is **parity in development**, not production: an app configured with Redis should
 * behave the same locally, rather than exercising a different algorithm and meeting the real one
 * for the first time under load.
 *
 * It counts per process, so behind a load balancer the effective limit is `limit × instances` —
 * the exact problem this package exists to solve, which is why the brick refuses it in production
 * unless told otherwise.
 */
export function memoryStore(options: MemoryStoreOptions = {}): RateLimitStore {
  const max = options.max ?? 10_000
  const windows = new Map<string, number>()

  return {
    name: 'memory',

    async hit(key: string, window: number, now: number): Promise<RateLimitResult> {
      const start = Math.floor(now / window) * window
      const current = `${key}:${start}`
      const prior = `${key}:${start - window}`

      const counted = (windows.get(current) ?? 0) + 1
      windows.set(current, counted)

      const elapsed = now - start
      const weight = (window - elapsed) / window
      const total = Math.floor((windows.get(prior) ?? 0) * weight + counted)

      // Swept here rather than on a timer: a background interval holds the process open at
      // shutdown, which turns a clean exit into a ten-second wait.
      if (windows.size > max) {
        const cutoff = start - window
        for (const [entry] of windows) {
          const at = Number(entry.slice(entry.lastIndexOf(':') + 1))
          if (at < cutoff) windows.delete(entry)
        }
      }

      return { count: total, resetMs: window - elapsed }
    },
  }
}
