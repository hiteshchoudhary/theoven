import { beforeEach, describe, expect, test } from 'bun:test'
import type { JobRecord, QueueDriver } from './types'

/**
 * The suite every `QueueDriver` must pass.
 *
 * Exported so the memory, Redis and Postgres drivers run the *same* tests rather than each
 * testing itself against its own reading of the contract. A queue whose semantics change with
 * its backend is a queue you can only trust in the environment you tested it in.
 *
 * The behaviours here are the ones the worker depends on: reserve is atomic, visibility expiry
 * reclaims a dead worker's jobs, dedupe holds while a job is pending, and dead-lettered jobs
 * stay until someone looks.
 *
 * ```ts
 * describeQueueDriver('memory', async () => memoryQueue())
 * ```
 */
export function describeQueueDriver(
  name: string,
  makeDriver: () => QueueDriver | Promise<QueueDriver>,
): void {
  describe(`QueueDriver conformance: ${name}`, () => {
    let driver: QueueDriver

    beforeEach(async () => {
      driver = await makeDriver()
      await driver.start?.()
    })

    function record(overrides: Partial<JobRecord> = {}): JobRecord {
      return {
        id: crypto.randomUUID(),
        name: 'test-job',
        payload: { value: 1 },
        attempts: 0,
        runAt: Date.now(),
        createdAt: Date.now(),
        ...overrides,
      }
    }

    describe('enqueue and reserve', () => {
      test('a pushed job is reserved, with its payload intact', async () => {
        const pushed = await driver.push(record({ payload: { value: 42, nested: { a: 'b' } } }))
        expect(pushed).not.toBeNull()

        const [reserved] = await driver.reserve(10, 30_000)
        expect(reserved?.id).toBe(pushed?.id as string)
        expect(reserved?.payload).toEqual({ value: 42, nested: { a: 'b' } })
      })

      test('reserving bumps the attempt count', async () => {
        await driver.push(record())
        const [reserved] = await driver.reserve(1, 30_000)
        expect(reserved?.attempts).toBe(1)
      })

      test('reserve honours its limit', async () => {
        for (let index = 0; index < 5; index++) await driver.push(record())
        expect(await driver.reserve(2, 30_000)).toHaveLength(2)
      })

      /**
       * The one that matters with more than one worker. A job handed out twice is an email sent
       * twice, or a payment taken twice.
       */
      test('a reserved job is not reserved again while it is in flight', async () => {
        await driver.push(record())

        const first = await driver.reserve(10, 30_000)
        const second = await driver.reserve(10, 30_000)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(0)
      })

      test('concurrent reserves never hand out the same job', async () => {
        for (let index = 0; index < 20; index++) await driver.push(record())

        const batches = await Promise.all([
          driver.reserve(20, 30_000),
          driver.reserve(20, 30_000),
          driver.reserve(20, 30_000),
        ])

        const ids = batches.flat().map((job) => job.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids).toHaveLength(20)
      })

      test('an empty queue reserves nothing rather than failing', async () => {
        expect(await driver.reserve(10, 30_000)).toEqual([])
      })
    })

    describe('scheduling', () => {
      test('a future job is not reserved yet', async () => {
        await driver.push(record({ runAt: Date.now() + 60_000 }))
        expect(await driver.reserve(10, 30_000)).toHaveLength(0)
      })

      test('a job whose time has passed is reserved', async () => {
        await driver.push(record({ runAt: Date.now() - 1000 }))
        expect(await driver.reserve(10, 30_000)).toHaveLength(1)
      })

      /**
       * What makes a worker crashing mid-job survivable. Without it the job is simply lost, and
       * "the queue is empty" and "a worker died holding it" look identical.
       */
      test('an expired visibility window makes a job runnable again', async () => {
        await driver.push(record())

        // A one-millisecond window, so it lapses immediately.
        expect(await driver.reserve(1, 1)).toHaveLength(1)
        await Bun.sleep(20)

        const reclaimed = await driver.reserve(1, 30_000)
        expect(reclaimed).toHaveLength(1)
        // Attempts keep counting across the reclaim, so a job that keeps killing workers still
        // eventually dies rather than looping forever.
        expect(reclaimed[0]?.attempts).toBe(2)
      })
    })

    describe('deduplication', () => {
      test('a second job with the same key while the first is pending is dropped', async () => {
        const first = await driver.push(record(), 'rebuild-index')
        const second = await driver.push(record(), 'rebuild-index')

        expect(first).not.toBeNull()
        expect(second).toBeNull()
        expect(await driver.reserve(10, 30_000)).toHaveLength(1)
      })

      test('the key frees up once the job completes', async () => {
        const first = await driver.push(record(), 'rebuild-index')
        await driver.complete((first as JobRecord).id)

        expect(await driver.push(record(), 'rebuild-index')).not.toBeNull()
      })

      test('different keys do not collide', async () => {
        expect(await driver.push(record(), 'a')).not.toBeNull()
        expect(await driver.push(record(), 'b')).not.toBeNull()
      })
    })

    describe('completing, retrying and dying', () => {
      test('a completed job is gone', async () => {
        const pushed = await driver.push(record())
        await driver.complete((pushed as JobRecord).id)

        expect(await driver.reserve(10, 30_000)).toHaveLength(0)
        expect((await driver.stats()).ready).toBe(0)
      })

      test('a retried job runs again at its new time', async () => {
        const pushed = await driver.push(record())
        const [reserved] = await driver.reserve(1, 30_000)

        await driver.retry({ ...(reserved as JobRecord), runAt: Date.now() - 1, lastError: 'boom' })

        const again = await driver.reserve(1, 30_000)
        expect(again[0]?.id).toBe((pushed as JobRecord).id)
        expect(again[0]?.lastError).toBe('boom')
      })

      test('a retry scheduled into the future waits', async () => {
        await driver.push(record())
        const [reserved] = await driver.reserve(1, 30_000)
        await driver.retry({ ...(reserved as JobRecord), runAt: Date.now() + 60_000 })

        expect(await driver.reserve(1, 30_000)).toHaveLength(0)
      })

      test('a killed job leaves the queue and appears in the dead letter', async () => {
        const pushed = await driver.push(record())
        const [reserved] = await driver.reserve(1, 30_000)
        await driver.kill({ ...(reserved as JobRecord), lastError: 'gave up' })

        expect(await driver.reserve(10, 30_000)).toHaveLength(0)

        const dead = await driver.dead(10)
        expect(dead).toHaveLength(1)
        expect(dead[0]?.id).toBe((pushed as JobRecord).id)
        // Why it died has to survive, or the dead letter is a list of ids and no help.
        expect(dead[0]?.lastError).toBe('gave up')
      })

      test('reviving puts it back with a full attempt budget', async () => {
        const pushed = await driver.push(record())
        const [reserved] = await driver.reserve(1, 30_000)
        await driver.kill({ ...(reserved as JobRecord), attempts: 4, lastError: 'gave up' })

        const revived = await driver.revive((pushed as JobRecord).id)
        expect(revived?.attempts).toBe(0)

        // Someone looked at it and decided it should run: it gets a full budget rather than
        // immediately dying on its one remaining try.
        const again = await driver.reserve(1, 30_000)
        expect(again[0]?.attempts).toBe(1)
        expect(await driver.dead(10)).toHaveLength(0)
      })

      test('reviving something that is not dead is null, not an error', async () => {
        expect(await driver.revive('never-existed')).toBeNull()
      })
    })

    describe('stats', () => {
      test('they separate ready, scheduled, active and dead', async () => {
        await driver.push(record())
        await driver.push(record())
        await driver.push(record({ runAt: Date.now() + 60_000 }))

        const [active] = await driver.reserve(1, 30_000)
        const killed = await driver.push(record())
        const [toKill] = await driver.reserve(1, 30_000)
        void killed
        await driver.kill({ ...(toKill as JobRecord), lastError: 'x' })

        const stats = await driver.stats()
        expect(stats.scheduled).toBe(1)
        expect(stats.active).toBe(1)
        expect(stats.dead).toBe(1)
        expect(active).toBeDefined()
      })

      test('an empty queue reports zeros', async () => {
        expect(await driver.stats()).toEqual({ ready: 0, scheduled: 0, active: 0, dead: 0 })
      })
    })

    describe('heartbeat', () => {
      test('it keeps a long-running job reserved', async () => {
        if (!driver.heartbeat) return

        await driver.push(record())
        const [reserved] = await driver.reserve(1, 100)

        await Bun.sleep(60)
        await driver.heartbeat((reserved as JobRecord).id, 30_000)
        await Bun.sleep(60)

        // Without the heartbeat the 100ms window would have lapsed and this would find it.
        expect(await driver.reserve(1, 30_000)).toHaveLength(0)
      })
    })
  })
}
