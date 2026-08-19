import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { queue } from './brick'
import { CronError, parseCron } from './cron'
import { renderDashboard } from './dashboard'
import { describeQueueDriver } from './driver-conformance'
import { defineJob } from './job'
import { memoryQueue } from './memory'
import { redisQueue } from './redis'
import { sqlQueue } from './sql'
import { type JobRecord, JobTimeout } from './types'
import { createWorker } from './worker'

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 0 })))
})

// ---------------------------------------------------------------------------------------
// The contract, run against every driver that is available
// ---------------------------------------------------------------------------------------

describeQueueDriver('memory', () => memoryQueue())

const REDIS_URL = process.env.REDIS_URL
if (REDIS_URL) {
  // A fresh prefix per suite run, so a previous run's leftovers cannot make this one pass.
  describeQueueDriver('redis', () =>
    redisQueue({ url: REDIS_URL, prefix: `oven:test:${crypto.randomUUID()}` }),
  )
} else {
  console.info('[queue] REDIS_URL not set — Redis conformance tests skipped.')
}

const POSTGRES_URL = process.env.POSTGRES_URL
if (POSTGRES_URL) {
  describeQueueDriver('postgres', () =>
    sqlQueue({ url: POSTGRES_URL, table: `oven_jobs_${crypto.randomUUID().replace(/-/g, '')}` }),
  )
} else {
  console.info('[queue] POSTGRES_URL not set — Postgres conformance tests skipped.')
}

// ---------------------------------------------------------------------------------------
// defineJob
// ---------------------------------------------------------------------------------------

describe('defineJob', () => {
  test('a name and a handler are required', () => {
    expect(() => defineJob({ name: '', handler: () => {} })).toThrow(/needs a name/)
    expect(() => defineJob({ name: 'x', handler: undefined as unknown as () => void })).toThrow(
      /needs a handler/,
    )
  })

  test('the payload type reaches the handler without a cast', async () => {
    const job = defineJob<{ userId: string }>({
      name: 'typed',
      handler: ({ payload }) => payload.userId.toUpperCase(),
    })
    expect(job.name).toBe('typed')
  })
})

// ---------------------------------------------------------------------------------------
// The worker: retries, backoff, timeouts, dead letter
// ---------------------------------------------------------------------------------------

describe('the worker', () => {
  function setup(definitions: Array<ReturnType<typeof defineJob>>, options = {}) {
    const driver = memoryQueue()
    const jobs = new Map(definitions.map((job) => [job.name, job]))
    const worker = createWorker(driver, jobs as never, { logger: silentLogger, ...options })
    return { driver, worker }
  }

  async function enqueue(
    driver: ReturnType<typeof memoryQueue>,
    name: string,
    payload: unknown = {},
  ) {
    return driver.push({
      id: crypto.randomUUID(),
      name,
      payload,
      attempts: 0,
      runAt: Date.now(),
      createdAt: Date.now(),
    })
  }

  test('it runs a job and removes it', async () => {
    const ran: unknown[] = []
    const job = defineJob<{ n: number }>({
      name: 'ok',
      handler: ({ payload }) => ran.push(payload.n),
    })
    const { driver, worker } = setup([job as never])

    await enqueue(driver, 'ok', { n: 1 })
    expect(await worker.drain()).toBe(1)

    expect(ran).toEqual([1])
    expect((await driver.stats()).ready).toBe(0)
  })

  test('a failing job is retried up to its budget, then dies', async () => {
    let attempts = 0
    const job = defineJob({
      name: 'flaky',
      retries: 2,
      backoff: 1,
      handler: () => {
        attempts++
        throw new Error('nope')
      },
    })
    const { driver, worker } = setup([job])

    await enqueue(driver, 'flaky')
    // Three runs: the first attempt plus two retries.
    for (let round = 0; round < 4; round++) {
      await worker.drain()
      await Bun.sleep(5)
    }

    expect(attempts).toBe(3)

    const dead = await driver.dead(10)
    expect(dead).toHaveLength(1)
    expect(dead[0]?.lastError).toBe('nope')
  })

  test('a job that succeeds on a retry is not dead-lettered', async () => {
    let attempts = 0
    const job = defineJob({
      name: 'eventually',
      retries: 3,
      backoff: 1,
      handler: () => {
        if (++attempts < 3) throw new Error('not yet')
      },
    })
    const { driver, worker } = setup([job])

    await enqueue(driver, 'eventually')
    for (let round = 0; round < 4; round++) {
      await worker.drain()
      await Bun.sleep(5)
    }

    expect(attempts).toBe(3)
    expect(await driver.dead(10)).toHaveLength(0)
  })

  // Exponential, so a dependency that is down is not hammered while it recovers.
  test('backoff grows with each attempt', async () => {
    const scheduled: number[] = []
    const driver = memoryQueue()
    const original = driver.retry
    driver.retry = async (record) => {
      scheduled.push(record.runAt - Date.now())
      await original(record)
    }

    const job = defineJob({
      name: 'backoff',
      retries: 3,
      backoff: 100,
      handler: () => {
        throw new Error('x')
      },
    })
    const worker = createWorker(driver, new Map([[job.name, job]]) as never, {
      logger: silentLogger,
    })

    await enqueue(driver, 'backoff')
    for (let round = 0; round < 4; round++) {
      await worker.drain()
      // Not waiting out the real backoff; the job simply is not runnable yet, which is fine —
      // what is asserted is the interval it was scheduled for.
      driver.jobs.forEach((record) => {
        record.runAt = Date.now()
      })
    }

    expect(scheduled[0]).toBeGreaterThanOrEqual(90)
    expect(scheduled[1]).toBeGreaterThanOrEqual(190)
    expect(scheduled[2]).toBeGreaterThanOrEqual(390)
  })

  /**
   * A handler that hangs must not hold a worker slot forever. The signal is aborted so a
   * handler that respects it stops; the race is what stops the *worker* waiting either way.
   */
  test('a hanging job times out and is retried', async () => {
    let aborted = false
    const job = defineJob({
      name: 'slow',
      retries: 1,
      backoff: 1,
      timeout: 30,
      handler: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(signal.reason)
          })
        }),
    })
    const { driver, worker } = setup([job], { timeout: 30, visibility: 1000 })

    await enqueue(driver, 'slow')
    await worker.drain()

    expect(aborted).toBe(true)
    const stored = [...driver.jobs.values()][0]
    expect(stored?.lastError).toContain('Timed out')
  })

  test('the timeout reason is a JobTimeout, distinct from a thrown error', async () => {
    let reason: unknown
    const job = defineJob({
      name: 'slow2',
      timeout: 20,
      retries: 0,
      handler: ({ signal }) =>
        new Promise(() => {
          signal.addEventListener('abort', () => {
            reason = signal.reason
          })
        }),
    })
    const { driver, worker } = setup([job], { timeout: 20, visibility: 1000 })

    await enqueue(driver, 'slow2')
    await worker.drain()

    expect(reason).toBeInstanceOf(JobTimeout)
  })

  /**
   * A deploy that removed a handler will not grow one back, so retrying would spin until the
   * attempts ran out while logging the same line.
   */
  test('a job with no registered handler is dead-lettered immediately', async () => {
    const { driver, worker } = setup([])

    await enqueue(driver, 'nobody-handles-this')
    await worker.drain()

    const dead = await driver.dead(10)
    expect(dead).toHaveLength(1)
    expect(dead[0]?.lastError).toContain('No handler registered')
  })

  test('concurrency is respected', async () => {
    let running = 0
    let peak = 0
    const job = defineJob({
      name: 'parallel',
      handler: async () => {
        peak = Math.max(peak, ++running)
        await Bun.sleep(20)
        running--
      },
    })
    const { driver, worker } = setup([job], { concurrency: 3 })

    for (let index = 0; index < 9; index++) await enqueue(driver, 'parallel')
    await worker.drain()

    expect(peak).toBeLessThanOrEqual(3)
    expect((await driver.stats()).ready).toBe(0)
  })

  /**
   * A slow job becoming visible again while it is still running means it runs twice. The worker
   * refuses to start rather than letting that happen quietly.
   */
  test('a visibility window shorter than the timeout is refused at construction', () => {
    expect(() =>
      createWorker(memoryQueue(), new Map(), { visibility: 1000, timeout: 5000 }),
    ).toThrow(/must exceed/)
  })

  // One job declaring a long timeout reintroduces the same problem, and would only show up as
  // a job that occasionally ran twice.
  test("a single job's timeout is checked too, and named", () => {
    const long = defineJob({ name: 'long-runner', timeout: 120_000, handler: () => {} })
    expect(() =>
      createWorker(memoryQueue(), new Map([[long.name, long]]) as never, { visibility: 60_000 }),
    ).toThrow(/long-runner/)
  })

  test('the default visibility follows the timeout, so raising one is enough', () => {
    // 5s timeout would have failed against a fixed 30s default the other way round; derived,
    // it is simply twice.
    expect(() => createWorker(memoryQueue(), new Map(), { timeout: 120_000 })).not.toThrow()
  })

  test('the handler sees its attempt number and what is left', async () => {
    const seen: Array<{ attempt: number; remaining: number }> = []
    const job = defineJob({
      name: 'counting',
      retries: 2,
      backoff: 1,
      handler: ({ attempt, remaining }) => {
        seen.push({ attempt, remaining })
        throw new Error('again')
      },
    })
    const { driver, worker } = setup([job])

    await enqueue(driver, 'counting')
    for (let round = 0; round < 4; round++) {
      await worker.drain()
      await Bun.sleep(5)
    }

    expect(seen[0]).toEqual({ attempt: 1, remaining: 2 })
    expect(seen[2]).toEqual({ attempt: 3, remaining: 0 })
  })

  test('stop waits for jobs in flight rather than abandoning them', async () => {
    let finished = false
    const job = defineJob({
      name: 'draining',
      handler: async () => {
        await Bun.sleep(40)
        finished = true
      },
    })
    const { driver, worker } = setup([job])

    await enqueue(driver, 'draining')
    worker.start()
    await Bun.sleep(20)

    await worker.stop()
    expect(finished).toBe(true)
    expect(worker.running).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------
// The brick
// ---------------------------------------------------------------------------------------

describe('the queue brick', () => {
  const hello = defineJob<{ name: string }>({ name: 'hello', handler: () => {} })

  function app(options = {}, development = true) {
    const driver = memoryQueue()
    const built = createApp({ logger: silentLogger, development }).use(
      queue(driver, { jobs: [hello as never], logger: silentLogger, worker: false, ...options }),
    )
    opened.push(built)
    return { app: built, driver }
  }

  test('dispatch enqueues with the payload', async () => {
    const { app: built, driver } = app()
    built.post('/x', (ctx) => ctx.queue.dispatch(hello, { name: 'Ada' }))
    await built.ready()

    const record = (await (
      await built.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    ).json()) as JobRecord

    expect(record.name).toBe('hello')
    expect(record.payload).toEqual({ name: 'Ada' })
    expect((await driver.stats()).ready).toBe(1)
  })

  test('a delay makes the job scheduled rather than ready', async () => {
    const { app: built, driver } = app()
    built.post('/x', (ctx) => ctx.queue.dispatch(hello, { name: 'Ada' }, { delay: 60_000 }))
    await built.ready()

    await built.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    const stats = await driver.stats()
    expect(stats.scheduled).toBe(1)
    expect(stats.ready).toBe(0)
  })

  test('a dedupe key collapses a burst into one job', async () => {
    const { app: built, driver } = app()
    built.post('/x', (ctx) => ctx.queue.dispatch(hello, { name: 'Ada' }, { key: 'reindex' }))
    await built.ready()

    for (let index = 0; index < 5; index++) {
      await built.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    }
    expect((await driver.stats()).ready).toBe(1)
  })

  /**
   * Dispatching a job no worker knows how to run means the job sits until it dead-letters. Boot
   * cannot catch it, but the dispatch can.
   */
  test('dispatching an unregistered job is refused, naming it', async () => {
    const stranger = defineJob({ name: 'stranger', handler: () => {} })
    const { app: built } = app()
    built.post('/x', (ctx) => ctx.queue.dispatch(stranger))
    await built.ready()

    const response = await built.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    expect(response.status).toBe(500)
  })

  test('two jobs with one name fail at boot', async () => {
    const twin = defineJob({ name: 'hello', handler: () => {} })
    const built = createApp({ logger: silentLogger, development: true }).use(
      queue(memoryQueue(), { jobs: [hello as never, twin as never] }),
    )
    opened.push(built)
    expect(built.ready()).rejects.toThrow(/Two jobs are named "hello"/)
  })

  /**
   * Jobs in a process's memory are lost when it restarts, and a deploy restarts it — silently
   * dropping every queued email while the service looks healthy.
   */
  test('the memory driver is refused in production', async () => {
    const built = createApp({ logger: silentLogger, development: false }).use(queue(memoryQueue()))
    opened.push(built)
    expect(built.ready()).rejects.toThrow(/refused in production/)
  })

  test('it can be allowed deliberately', async () => {
    const built = createApp({ logger: silentLogger, development: false }).use(
      queue(memoryQueue(), { allowMemoryInProduction: true, worker: false }),
    )
    opened.push(built)
    await built.ready()
  })

  test('the in-process worker runs jobs end to end', async () => {
    const ran: string[] = []
    const job = defineJob<{ name: string }>({
      name: 'greet',
      handler: ({ payload }) => ran.push(payload.name),
    })
    const built = createApp({ logger: silentLogger, development: true }).use(
      queue(memoryQueue(), { jobs: [job as never], logger: silentLogger, pollInterval: 5 }),
    )
    opened.push(built)
    built.post('/x', (ctx) => ctx.queue.dispatch(job, { name: 'Ada' }))
    await built.ready()

    await built.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    for (let attempt = 0; attempt < 40 && ran.length === 0; attempt++) await Bun.sleep(10)

    expect(ran).toEqual(['Ada'])
  })

  test('the dashboard is mounted in development and shows the counts', async () => {
    const { app: built } = app({ jobs: [hello as never] })
    built.post('/x', (ctx) => ctx.queue.dispatch(hello, { name: 'Ada' }))
    await built.ready()
    await built.fetch(new Request('https://theoven.app/x', { method: 'POST' }))

    const page = await built.fetch(new Request('https://theoven.app/_oven/queue'))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('hello')
  })

  test('the dashboard is off outside development', async () => {
    const { app: built } = app({ allowMemoryInProduction: true }, false)
    await built.ready()
    expect((await built.fetch(new Request('https://theoven.app/_oven/queue'))).status).toBe(404)
  })

  test('a cron entry naming an unregistered job fails at boot', async () => {
    const stranger = defineJob({ name: 'stranger', handler: () => {} })
    const built = createApp({ logger: silentLogger, development: true }).use(
      queue(memoryQueue(), {
        jobs: [hello as never],
        cron: { nightly: { schedule: '0 3 * * *', job: stranger as never } },
      }),
    )
    opened.push(built)
    expect(built.ready()).rejects.toThrow(/not registered/)
  })

  test('a bad cron expression fails at boot', async () => {
    const built = createApp({ logger: silentLogger, development: true }).use(
      queue(memoryQueue(), {
        jobs: [hello as never],
        cron: { nightly: { schedule: 'not a schedule', job: hello as never } },
      }),
    )
    opened.push(built)
    expect(built.ready()).rejects.toThrow(/cron expression/)
  })

  test('shutdown drains the worker rather than abandoning jobs', async () => {
    let finished = false
    const slow = defineJob({
      name: 'slow',
      handler: async () => {
        await Bun.sleep(30)
        finished = true
      },
    })
    const built = createApp({ logger: silentLogger, development: true }).use(
      queue(memoryQueue(), { jobs: [slow as never], logger: silentLogger, pollInterval: 5 }),
    )
    built.post('/x', (ctx) => ctx.queue.dispatch(slow))
    await built.ready()

    await built.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    await Bun.sleep(20)
    await built.close({ timeout: 1000 })

    expect(finished).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------
// Cron parsing
// ---------------------------------------------------------------------------------------

describe('cron expressions', () => {
  const at = (iso: string) => new Date(iso)

  test('every fifteen minutes', () => {
    const schedule = parseCron('*/15 * * * *')
    expect(schedule.matches(at('2026-08-19T10:00:00'))).toBe(true)
    expect(schedule.matches(at('2026-08-19T10:15:00'))).toBe(true)
    expect(schedule.matches(at('2026-08-19T10:16:00'))).toBe(false)
  })

  test('a daily time', () => {
    const schedule = parseCron('30 3 * * *')
    expect(schedule.matches(at('2026-08-19T03:30:00'))).toBe(true)
    expect(schedule.matches(at('2026-08-19T04:30:00'))).toBe(false)
  })

  test('named months and weekdays', () => {
    const schedule = parseCron('0 9 * * mon-fri')
    expect(schedule.matches(at('2026-08-19T09:00:00'))).toBe(true) // Wednesday
    expect(schedule.matches(at('2026-08-22T09:00:00'))).toBe(false) // Saturday
  })

  test('lists and ranges', () => {
    const schedule = parseCron('0 9,17 1-5 * *')
    expect(schedule.matches(at('2026-08-03T17:00:00'))).toBe(true)
    expect(schedule.matches(at('2026-08-06T17:00:00'))).toBe(false)
  })

  test('aliases', () => {
    expect(parseCron('@daily').matches(at('2026-08-19T00:00:00'))).toBe(true)
    expect(parseCron('@hourly').matches(at('2026-08-19T07:00:00'))).toBe(true)
  })

  // Standard cron, and the one rule everybody gets wrong: with both restricted, either matches.
  test('day-of-month and day-of-week are an OR when both are restricted', () => {
    const schedule = parseCron('0 0 1 * mon')
    expect(schedule.matches(at('2026-08-01T00:00:00'))).toBe(true) // the 1st, a Saturday
    expect(schedule.matches(at('2026-08-03T00:00:00'))).toBe(true) // a Monday
    expect(schedule.matches(at('2026-08-04T00:00:00'))).toBe(false)
  })

  test('7 means Sunday, as well as 0', () => {
    expect(parseCron('0 0 * * 7').matches(at('2026-08-23T00:00:00'))).toBe(true)
  })

  test('next returns the following occurrence, never the current minute', () => {
    const schedule = parseCron('0 * * * *')
    const next = schedule.next(at('2026-08-19T10:00:00'))
    expect(next.toISOString().slice(0, 16)).toBe('2026-08-19T11:00')
  })

  test('malformed expressions are rejected with an explanation', () => {
    expect(() => parseCron('* * *')).toThrow(CronError)
    expect(() => parseCron('99 * * * *')).toThrow(/outside this field's range/)
    expect(() => parseCron('bad * * * *')).toThrow(/not a number/)
    expect(() => parseCron('30-10 * * * *')).toThrow(/backwards/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/invalid step/)
  })
})

// ---------------------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------------------

describe('dashboard', () => {
  test('it shows counts, dead jobs and schedules', () => {
    const html = renderDashboard({
      driver: 'memory',
      stats: { ready: 3, scheduled: 1, active: 2, dead: 4 },
      dead: [
        {
          id: 'job-1',
          name: 'send-email',
          payload: {},
          attempts: 4,
          runAt: 0,
          createdAt: 0,
          lastError: 'SMTP refused',
        },
      ],
      jobs: ['send-email', 'resize-avatar'],
      cron: [
        {
          name: 'nightly',
          schedule: '0 3 * * *',
          job: 'clean-up',
          next: '2026-08-20T03:00:00.000Z',
        },
      ],
    })

    expect(html).toContain('send-email')
    expect(html).toContain('SMTP refused')
    expect(html).toContain('0 3 * * *')
    expect(html).toContain('>3<')
  })

  /**
   * A dead job's `lastError` is whatever the failure produced, and some of that started as user
   * input — an email address, a filename.
   */
  test('a hostile error message cannot script the page', () => {
    const html = renderDashboard({
      driver: 'memory',
      stats: { ready: 0, scheduled: 0, active: 0, dead: 1 },
      dead: [
        {
          id: '<img src=x onerror=alert(1)>',
          name: '</code><script>alert(1)</script>',
          payload: {},
          attempts: 1,
          runAt: 0,
          createdAt: 0,
          lastError: '<script>alert("error")</script>',
        },
      ],
      jobs: [],
      cron: [],
    })

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<script>alert("error")</script>')
    expect(html).not.toContain('<img src=x')
  })
})
