import type { Brick, Logger } from '@theoven/core'
import { type CronSchedule, parseCron } from './cron'
import { renderDashboard } from './dashboard'
import type { JobDefinition } from './job'
import { memoryQueue } from './memory'
import {
  type EnqueueOptions,
  type JobRecord,
  type QueueDriver,
  QueueError,
  type QueueStats,
} from './types'
import { createWorker, type Worker, type WorkerOptions } from './worker'

export interface CronEntry {
  /** A cron expression, or a name like `@daily`. */
  schedule: string
  /** The job to enqueue. */
  job: JobDefinition<never>
  /** Payload for each run. */
  payload?: unknown
}

export interface QueueOptions extends WorkerOptions {
  /** Every job this app can run. Registered up front so a worker knows what a stored name means. */
  jobs?: ReadonlyArray<JobDefinition<never>>
  /**
   * Scheduled jobs, keyed by a name that appears in logs and on the dashboard.
   *
   * ```ts
   * cron: { nightly: { schedule: '0 3 * * *', job: cleanUp } }
   * ```
   */
  cron?: Record<string, CronEntry>
  /**
   * Run jobs in this process. Default: on in development, off in production.
   *
   * Off in production because that is where you want workers to scale separately from web
   * servers — `oven worker` is the other half. On in development because starting two processes
   * to see a job run is friction with no payoff.
   */
  worker?: boolean
  /**
   * Run the memory driver outside development.
   *
   * Refused by default. Jobs held in a process's memory are lost when it restarts, and a deploy
   * restarts it — silently dropping every queued email while the service looks healthy.
   */
  allowMemoryInProduction?: boolean
  /** Mount the dashboard. Default: on in development, off elsewhere. A string moves it. */
  dashboard?: boolean | string
}

/** What `ctx.queue` exposes. */
export interface QueueService {
  readonly driver: string
  /**
   * Enqueues a job.
   *
   * The payload type comes from the definition, so the wrong shape is a compile error rather
   * than a handler crashing in a worker an hour later.
   */
  dispatch<Payload>(
    job: JobDefinition<Payload>,
    ...args: Payload extends void
      ? [payload?: undefined, options?: EnqueueOptions]
      : [payload: Payload, options?: EnqueueOptions]
  ): Promise<JobRecord | null>
  stats(): Promise<QueueStats>
  /** Dead-lettered jobs, newest first. */
  dead(limit?: number): Promise<JobRecord[]>
  /** Puts a dead-lettered job back on the queue with its attempts reset. */
  revive(id: string): Promise<JobRecord | null>
  /** The in-process worker, when one is running. */
  readonly worker: Worker | undefined
  /**
   * Every registered job, by name.
   *
   * Exposed so `oven worker` runs the app's own definitions rather than a set declared
   * separately — a worker that knew different jobs would dead-letter what it did not recognise.
   */
  readonly jobs: ReadonlyMap<string, JobDefinition<never>>
  /** The underlying driver, for whatever the contract does not cover. */
  readonly raw: unknown
}

const DASHBOARD_PATH = '/_oven/queue'

/**
 * The queue brick.
 *
 * ```ts
 * app.use(queue(memoryQueue(), { jobs: [resizeAvatar, sendDigest] }))
 *
 * app.post('/avatar', async (ctx) => {
 *   await ctx.queue.dispatch(resizeAvatar, { userId: ctx.user.id, url })
 *   return { queued: true }
 * })
 * ```
 *
 * Defaults to an in-process driver so a freshly created app has working background jobs with
 * nothing to install. Moving to Redis or Postgres is one driver.
 */
export function queue(
  driver: QueueDriver = memoryQueue(),
  options: QueueOptions = {},
): Brick<'queue', QueueService> {
  return {
    name: 'queue',

    setup: async (context) => {
      if (!context.development && driver.name === 'memory' && !options.allowMemoryInProduction) {
        throw new QueueError(
          'The in-memory queue driver is refused in production: jobs live in this process, so a ' +
            'deploy silently drops every queued email and the service looks healthy while it ' +
            'happens. Configure a Redis or Postgres driver, or pass allowMemoryInProduction if ' +
            'losing queued work on restart is genuinely acceptable.',
          { driver: 'memory' },
        )
      }

      const jobs = new Map<string, JobDefinition<never>>()
      for (const job of options.jobs ?? []) {
        if (jobs.has(job.name)) {
          // Two handlers for one name means whichever registered last silently wins, and the
          // other never runs. Boot is the right time to find that out.
          throw new QueueError(`Two jobs are named "${job.name}".`, { job: job.name })
        }
        jobs.set(job.name, job)
      }

      await driver.start?.()

      const logger = options.logger ?? context.app.logger
      const runWorker = options.worker ?? context.development
      const worker = runWorker ? createWorker(driver, jobs, { ...options, logger }) : undefined

      const service: QueueService = {
        driver: driver.name,
        raw: driver,
        worker,
        jobs,

        dispatch: async (job, payload?: unknown, enqueue: EnqueueOptions = {}) => {
          if (!jobs.has(job.name)) {
            throw new QueueError(
              `The job "${job.name}" is not registered. Add it to queue({ jobs: [...] }), or a ` +
                'worker will receive it and have nothing to run.',
              { job: job.name, driver: driver.name },
            )
          }

          const merged = { ...job.defaults, ...enqueue }
          const runAt = merged.runAt
            ? new Date(merged.runAt).getTime()
            : Date.now() + (merged.delay ?? 0)

          return driver.push(
            {
              id: crypto.randomUUID(),
              name: job.name,
              payload,
              attempts: 0,
              runAt,
              createdAt: Date.now(),
            },
            merged.key,
          )
        },

        stats: () => driver.stats(),
        dead: (limit = 50) => driver.dead(limit),
        revive: (id) => driver.revive(id),
      }

      const schedules = startCron(options.cron ?? {}, service, jobs, logger)
      const dashboardPath = resolveDashboard(options.dashboard, context.development)

      if (dashboardPath) {
        context.route('GET', dashboardPath, async () => {
          const [stats, dead] = await Promise.all([service.stats(), service.dead(20)])
          return html(
            renderDashboard({
              driver: driver.name,
              stats,
              dead,
              jobs: [...jobs.keys()],
              cron: schedules.described,
            }),
          )
        })
      }

      // Stopping the worker is what makes shutdown drain rather than abandon.
      pendingShutdown.set(service, async () => {
        schedules.stop()
        await worker?.stop()
        await driver.close?.()
      })

      worker?.start()
      return service
    },

    onShutdown: async (service) => {
      await pendingShutdown.get(service)?.()
      pendingShutdown.delete(service)
    },
  }
}

/**
 * Shutdown work, kept off the service object.
 *
 * `ctx.queue` is a public surface; a `stop()` on it would invite a route handler to shut the
 * worker down, which is not a thing a request should be able to do.
 */
const pendingShutdown = new WeakMap<QueueService, () => Promise<void>>()

interface StartedCron {
  stop(): void
  described: Array<{ name: string; schedule: string; job: string; next: string }>
}

/**
 * Schedules cron entries.
 *
 * A one-minute tick that checks which expressions match, rather than a timer per entry: cron
 * granularity is a minute, and one timer is easier to stop cleanly at shutdown than twenty.
 */
function startCron(
  entries: Record<string, CronEntry>,
  service: QueueService,
  jobs: Map<string, JobDefinition<never>>,
  logger: Logger,
): StartedCron {
  const parsed: Array<{ name: string; entry: CronEntry; schedule: CronSchedule }> = []

  for (const [name, entry] of Object.entries(entries)) {
    if (!jobs.has(entry.job.name)) {
      throw new QueueError(
        `The cron entry "${name}" runs the job "${entry.job.name}", which is not registered. ` +
          'Add it to queue({ jobs: [...] }).',
        { job: entry.job.name },
      )
    }
    parsed.push({ name, entry, schedule: parseCron(entry.schedule) })
  }

  if (parsed.length === 0) return { stop: () => {}, described: [] }

  let lastMinute = ''
  const tick = setInterval(() => {
    const now = new Date()
    // One dispatch per matching minute, whatever the tick rate or a clock adjustment does.
    const minute = `${now.toDateString()} ${now.getHours()}:${now.getMinutes()}`
    if (minute === lastMinute) return
    lastMinute = minute

    for (const { name, entry, schedule } of parsed) {
      if (!schedule.matches(now)) continue

      logger.info('queue: cron fired', { cron: name, job: entry.job.name })
      /**
       * Cast because `dispatch`'s signature is deliberately conditional on the payload type,
       * which is the right trade for callers and useless here — a cron entry's payload is
       * `unknown` by the time it reaches this loop.
       */
      const enqueue = service.dispatch as (
        job: JobDefinition<unknown>,
        payload: unknown,
        options: EnqueueOptions,
      ) => Promise<JobRecord | null>

      void enqueue(entry.job as JobDefinition<unknown>, entry.payload, {
        // The key is the minute, so two instances both ticking enqueue the job once.
        key: `cron:${name}:${minute}`,
      }).catch((cause: unknown) => {
        logger.error('queue: cron dispatch failed', {
          cron: name,
          cause: cause instanceof Error ? cause.message : String(cause),
        })
      })
    }
  }, 15_000)

  // Never hold the process open just because a schedule exists.
  tick.unref?.()

  return {
    stop: () => clearInterval(tick),
    described: parsed.map(({ name, entry, schedule }) => ({
      name,
      schedule: entry.schedule,
      job: entry.job.name,
      next: schedule.next().toISOString(),
    })),
  }
}

function resolveDashboard(
  dashboard: boolean | string | undefined,
  development: boolean,
): string | undefined {
  if (dashboard === false) return undefined
  if (typeof dashboard === 'string') return dashboard.startsWith('/') ? dashboard : `/${dashboard}`
  if (dashboard === true) return DASHBOARD_PATH
  return development ? DASHBOARD_PATH : undefined
}

function html(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}
