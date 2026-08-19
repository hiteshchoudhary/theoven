import type { CacheDriver, CacheEntry, SetOptions } from './types'

export interface MemoryCacheOptions {
  /**
   * Maximum entries before the least-recently-used are evicted. Default 10 000.
   *
   * An unbounded in-process cache is a memory leak with a friendly name — it grows until the
   * process dies, and the failure looks like a leak somewhere else entirely.
   */
  max?: number
}

/**
 * An in-process cache with LRU eviction.
 *
 * The default, and what tests use. Per process, so behind several instances each has its own —
 * which is fine for derived data and wrong for anything that must agree across instances.
 */
export function memoryCache(options: MemoryCacheOptions = {}): CacheDriver {
  const max = options.max ?? 10_000

  /** Insertion order is recency: re-setting moves a key to the end. */
  const entries = new Map<string, CacheEntry>()
  const tags = new Map<string, Set<string>>()
  const keyTags = new Map<string, readonly string[]>()

  function forget(key: string): void {
    entries.delete(key)
    for (const tag of keyTags.get(key) ?? []) {
      const members = tags.get(tag)
      members?.delete(key)
      if (members?.size === 0) tags.delete(tag)
    }
    keyTags.delete(key)
  }

  return {
    name: 'memory',
    raw: entries,

    get: async (key) => {
      const entry = entries.get(key)
      if (!entry) return undefined

      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        forget(key)
        return undefined
      }

      // Touch it, so eviction sees this as the most recent.
      entries.delete(key)
      entries.set(key, entry)
      return entry
    },

    set: async (key, entry, options) => {
      forget(key)
      entries.set(key, entry)

      if (options.tags?.length) {
        keyTags.set(key, options.tags)
        for (const tag of options.tags) {
          const members = tags.get(tag) ?? new Set<string>()
          members.add(key)
          tags.set(tag, members)
        }
      }

      // Evict from the front, which is the least recently used.
      while (entries.size > max) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        forget(oldest)
      }
    },

    delete: async (key) => forget(key),

    invalidate: async (tag) => {
      const members = tags.get(tag)
      if (!members) return 0

      const count = members.size
      for (const key of [...members]) forget(key)
      return count
    },

    clear: async () => {
      entries.clear()
      tags.clear()
      keyTags.clear()
    },
  }
}
