import type { Logger } from '@theoven/core'
import type { JobContext, JobDefinition } from './job'
import { type JobRecord, JobTimeout, type QueueDriver } from './types'

export interface WorkerOptions {
  /** Jobs run at once. Default 5. */
  concurrency?: number
  /** Milliseconds between polls when the queue is empty. Default 500. */
  pollInterval?: number
  /**
   * Milliseconds a reserved job stays invisible to other workers. Default: twice the timeout.
   *
   * Must exceed the longest job timeout, or a slow job becomes visible again and runs twice
   * while the first attempt is still going. Derived from the timeout by default so that raising
   * one does not silently need the other raised too — the worker refuses to start if a
   * hand-set pair is unsafe.
   */
  visibility?: number
  /** Default attempts after the first, when a job does not say. Default 3. */
  retries?: number
  /** Default milliseconds before the first retry; doubles each attempt. Default 1000. */
  backoff?: number
  /** Default milliseconds one attempt may take. Default 30000. */
  timeout?: number
  logger?: Logger
}

export interface Worker {
  /** Starts polling. Resolves once the loop is running, not when it finishes. */
  start(): void
  /**
   * Stops taking new jobs and waits for the ones in flight.
   *
   * Their `signal` is aborted after `grace` milliseconds so a handler that respects it can stop
   * early rather than being abandoned mid-write.
   */
  stop(grace?: number): Promise<void>
  /**
   * Runs whatever is currently runnable and returns how many jobs it processed.
   *
   * For tests, and for a one-shot worker in a cron container. Nothing polls.
   */
  drain(): Promise<number>
  readonly running: number
}

const DEFAULTS = {
  concurrency: 5,
  pollInterval: 500,
  retries: 3,
  backoff: 1000,
  timeout: 30_000,
} as const

/**
 * Runs jobs.
 *
 * Policy lives here rather than in a driver, so retries, backoff, timeouts and the dead-letter
 * rule behave identically on memory, Redis and Postgres. A queue whose semantics change with its
 * backend is a queue you can only test in staging.
 */
export function createWorker(
  driver: QueueDriver,
  jobs: Map<string, JobDefinition<never>>,
  options: WorkerOptions = {},
): Worker {
  const given = strip(options)
  const timeout = given.timeout ?? DEFAULTS.timeout
  const settings = {
    ...DEFAULTS,
    // Twice the timeout, so a job that runs right up to its limit still finishes well inside
    // its reservation.
    visibility: timeout * 2,
    ...given,
  }
  const logger = options.logger

  /**
   * Every timeout, not just the default.
   *
   * A single job declaring `timeout: 120_000` on a worker whose window is 60s reintroduces the
   * exact problem the default was derived to avoid — and it would only show up as a job that
   * occasionally ran twice.
   */
  const longest = Math.max(
    settings.timeout,
    ...[...jobs.values()].map((job) => job.timeout ?? settings.timeout),
  )

  if (settings.visibility <= longest) {
    const culprit = [...jobs.values()].find((job) => (job.timeout ?? 0) === longest)
    const source = culprit ? ` (from the job "${culprit.name}")` : ''
    throw new Error(
      `A worker's visibility window (${settings.visibility}ms) must exceed its longest job ` +
        `timeout (${longest}ms${source}), or a slow job becomes visible to another worker and ` +
        'runs twice while the first attempt is still going. Raise `visibility`, or lower the ' +
        'timeout.',
    )
  }

  const inFlight = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  let polling = false
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined

  async function runOne(record: JobRecord): Promise<void> {
    const definition = jobs.get(record.name)

    if (!definition) {
      /**
       * A job whose handler is not registered.
       *
       * Dead-lettered rather than retried: a deploy that removed the handler will not grow one
       * back, and retrying would spin until the attempts ran out while logging the same line.
       */
      logger?.error('queue: no handler registered', { job: record.name, id: record.id })
      await driver.kill({ ...record, lastError: `No handler registered for "${record.name}".` })
      return
    }

    const retries = definition.retries ?? settings.retries
    const timeout = definition.timeout ?? settings.timeout
    const backoff = definition.backoff ?? settings.backoff

    const controller = new AbortController()
    controllers.add(controller)
    const expiry = setTimeout(
      () => controller.abort(new JobTimeout(`Timed out after ${timeout}ms.`)),
      timeout,
    )

    // Keeps the reservation alive for a job legitimately taking a while, so a long job is not
    // reclaimed and run twice.
    const beat = driver.heartbeat
      ? setInterval(
          () => {
            void driver.heartbeat?.(record.id, settings.visibility).catch(() => {})
          },
          Math.max(1000, Math.floor(settings.visibility / 3)),
        )
      : undefined

    const context: JobContext<never> = {
      payload: record.payload as never,
      id: record.id,
      attempt: record.attempts,
      remaining: Math.max(0, retries - record.attempts + 1),
      signal: controller.signal,
      log: child(logger, record),
    }

    try {
      // Raced against the signal so a handler ignoring it still cannot hold the worker open
      // forever. The handler keeps running, which is why passing `signal` through matters.
      await Promise.race([definition.handler(context), rejectOnAbort(controller.signal)])

      await driver.complete(record.id)
      logger?.info('queue: job done', { job: record.name, id: record.id, attempt: record.attempts })
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown)

      if (record.attempts > retries) {
        logger?.error('queue: job dead', {
          job: record.name,
          id: record.id,
          attempts: record.attempts,
          cause: message,
        })
        await driver.kill({ ...record, lastError: message })
        return
      }

      // Exponential, so a dependency that is down is not hammered while it recovers.
      const wait = backoff * 2 ** (record.attempts - 1)
      logger?.warn('queue: job failed, retrying', {
        job: record.name,
        id: record.id,
        attempt: record.attempts,
        retryIn: wait,
        cause: message,
      })
      await driver.retry({ ...record, runAt: Date.now() + wait, lastError: message })
    } finally {
      clearTimeout(expiry)
      if (beat) clearInterval(beat)
      controllers.delete(controller)
    }
  }

  /** Takes as many jobs as there is room for and starts them. Returns how many it started. */
  async function pump(): Promise<number> {
    const room = settings.concurrency - inFlight.size
    if (room <= 0 || stopping) return 0

    const reserved = await driver.reserve(room, settings.visibility)

    for (const record of reserved) {
      const promise = runOne(record)
        .catch((thrown: unknown) => {
          // A failure in the *machinery* — the driver rejecting, say. Losing it silently would
          // make a broken queue look like an idle one.
          logger?.error('queue: worker error', {
            job: record.name,
            id: record.id,
            cause: thrown instanceof Error ? thrown.message : String(thrown),
          })
        })
        .finally(() => {
          inFlight.delete(promise)
        })
      inFlight.add(promise)
    }

    return reserved.length
  }

  async function loop(): Promise<void> {
    if (!polling || stopping) return

    let started = 0
    try {
      started = await pump()
    } catch (thrown) {
      logger?.error('queue: reserve failed', {
        cause: thrown instanceof Error ? thrown.message : String(thrown),
      })
    }

    // Straight back round when there was work: a burst should drain at full speed rather than
    // one batch per poll interval.
    timer = setTimeout(() => void loop(), started > 0 ? 0 : settings.pollInterval)
    timer.unref?.()
  }

  return {
    get running() {
      return inFlight.size
    },

    start: () => {
      if (polling) return
      polling = true
      stopping = false
      void loop()
    },

    stop: async (grace = 10_000) => {
      stopping = true
      polling = false
      if (timer) clearTimeout(timer)

      const abort = setTimeout(() => {
        for (const controller of controllers) {
          controller.abort(new JobTimeout('The worker is shutting down.'))
        }
      }, grace)
      abort.unref?.()

      await Promise.all([...inFlight])
      clearTimeout(abort)
    },

    drain: async () => {
      let processed = 0
      // Until nothing more is runnable: a job that enqueues another should see the second one
      // run in the same drain, which is what a test expects.
      for (;;) {
        const started = await pump()
        await Promise.all([...inFlight])
        if (started === 0) return processed
        processed += started
      }
    },
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/** A logger tagged with the job, so a worker's output is greppable by job name. */
function child(logger: Logger | undefined, record: JobRecord): JobContext<never>['log'] {
  const tag = { job: record.name, id: record.id }
  const write =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, fields: Record<string, unknown> = {}) => {
      logger?.[level](message, { ...tag, ...fields })
    }

  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/** Drops undefined values, so `{ concurrency: undefined }` does not beat a default. */
function strip<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}
