import type { JobRecord, QueueDriver, QueueStats } from './types'

/**
 * An in-process queue.
 *
 * The default, and the reason `oven create` produces an app where background jobs work with no
 * Redis and no Postgres. Also what tests use: a job dispatched in a test can be run in the same
 * test, synchronously, with no service to start.
 *
 * Everything is lost when the process exits, which is why the brick refuses it in production
 * unless you say otherwise.
 */
export function memoryQueue(): QueueDriver & { readonly jobs: Map<string, JobRecord> } {
  const jobs = new Map<string, JobRecord>()
  /** id → visibility deadline. Present means in flight. */
  const active = new Map<string, number>()
  const dead: JobRecord[] = []
  /** Dedupe key → job id, for jobs still pending. */
  const keys = new Map<string, string>()
  const keyOf = new Map<string, string>()

  function release(id: string): void {
    active.delete(id)
    const key = keyOf.get(id)
    if (key) {
      keys.delete(key)
      keyOf.delete(id)
    }
  }

  return {
    name: 'memory',
    jobs,

    push: async (record, key) => {
      if (key) {
        const existing = keys.get(key)
        // Still pending, so this is the same work asked for twice.
        if (existing && jobs.has(existing)) return null
        keys.set(key, record.id)
        keyOf.set(record.id, key)
      }
      jobs.set(record.id, record)
      return record
    },

    reserve: async (count, visibility) => {
      const now = Date.now()
      const taken: JobRecord[] = []

      for (const record of jobs.values()) {
        if (taken.length >= count) break
        if (record.runAt > now) continue

        // An expired visibility deadline means the worker holding it died. Reclaiming is what
        // makes a crash mid-job recoverable rather than a job lost forever.
        const deadline = active.get(record.id)
        if (deadline !== undefined && deadline > now) continue

        active.set(record.id, now + visibility)
        record.attempts++
        taken.push({ ...record })
      }

      return taken
    },

    complete: async (id) => {
      jobs.delete(id)
      release(id)
    },

    retry: async (record) => {
      jobs.set(record.id, { ...record })
      active.delete(record.id)
    },

    kill: async (record) => {
      jobs.delete(record.id)
      release(record.id)
      dead.unshift({ ...record })
    },

    heartbeat: async (id, visibility) => {
      if (active.has(id)) active.set(id, Date.now() + visibility)
    },

    stats: async (): Promise<QueueStats> => {
      const now = Date.now()
      let ready = 0
      let scheduled = 0
      let running = 0

      for (const record of jobs.values()) {
        const deadline = active.get(record.id)
        if (deadline !== undefined && deadline > now) running++
        else if (record.runAt > now) scheduled++
        else ready++
      }

      return { ready, scheduled, active: running, dead: dead.length }
    },

    dead: async (limit) => dead.slice(0, limit),

    revive: async (id) => {
      const index = dead.findIndex((record) => record.id === id)
      if (index === -1) return null

      const [record] = dead.splice(index, 1)
      if (!record) return null

      // Attempts reset: someone looked at it and decided it should run again, so it gets a full
      // budget rather than immediately dying on its one remaining try.
      const revived: JobRecord = { ...record, attempts: 0, runAt: Date.now(), lastError: undefined }
      jobs.set(revived.id, revived)
      return revived
    },
  }
}
