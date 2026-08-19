/**
 * The queue contract.
 *
 * A driver stores jobs and hands them out; it does not decide policy. Retries, backoff,
 * timeouts and the dead-letter rule all live in the worker, so they behave identically whether
 * the jobs are in memory, in Redis or in Postgres — which is the difference between a queue you
 * can test locally and a queue you can only test in staging.
 */

/** A job waiting, running, or finished. */
export interface JobRecord<Payload = unknown> {
  id: string
  /** The job name, matching a `defineJob` definition. */
  name: string
  payload: Payload
  /** How many times this job has been handed to a worker. */
  attempts: number
  /** Epoch milliseconds before which the job must not run. */
  runAt: number
  /** When it was first enqueued. */
  createdAt: number
  /** Set when a run failed, so a dashboard and a dead-letter entry can show why. */
  lastError?: string | undefined
}

export interface EnqueueOptions {
  /** Milliseconds to wait before the job becomes runnable. */
  delay?: number | undefined
  /** Absolute time to run at. Wins over `delay` when both are given. */
  runAt?: Date | number | undefined
  /**
   * Deduplication key.
   *
   * A second job with the same key, while the first is still pending, is dropped. This is how a
   * "rebuild the search index" job triggered by fifty writes runs once rather than fifty times.
   */
  key?: string | undefined
  /** Overrides the definition's retry count for this one job. */
  retries?: number | undefined
}

/** What a queue backend must provide. */
export interface QueueDriver {
  /** Identifies the driver in logs and errors, e.g. `memory`, `redis`, `postgres`. */
  readonly name: string

  /** Called once at boot, before anything is enqueued. */
  start?(): Promise<void> | void

  /**
   * Adds a job.
   *
   * Returns the record as stored, or `null` when a `key` matched something already pending —
   * so a caller can tell "queued" from "already queued" without a second round trip.
   */
  push(record: JobRecord, key?: string | undefined): Promise<JobRecord | null>

  /**
   * Takes up to `count` runnable jobs and marks them in flight for `visibility` milliseconds.
   *
   * Must be atomic against other workers: two workers reserving at the same moment must not
   * receive the same job. A job whose visibility expires becomes runnable again, which is what
   * makes a worker crashing mid-job recoverable rather than a lost job.
   */
  reserve(count: number, visibility: number): Promise<JobRecord[]>

  /** Removes a finished job. */
  complete(id: string): Promise<void>

  /** Puts a job back to run again at `runAt`, recording why it failed. */
  retry(record: JobRecord): Promise<void>

  /** Moves a job to the dead-letter store, where it stays until someone looks. */
  kill(record: JobRecord): Promise<void>

  /** Extends the in-flight deadline for a job still running. */
  heartbeat?(id: string, visibility: number): Promise<void>

  stats(): Promise<QueueStats>
  /** Dead-lettered jobs, newest first. */
  dead(limit: number): Promise<JobRecord[]>
  /** Puts a dead-lettered job back on the queue with its attempts reset. */
  revive(id: string): Promise<JobRecord | null>

  close?(): Promise<void> | void
}

export interface QueueStats {
  /** Runnable now. */
  ready: number
  /** Waiting for `runAt`. */
  scheduled: number
  /** Handed to a worker and not yet finished. */
  active: number
  /** Given up on. */
  dead: number
}

/** Raised when a queue operation fails. Names the driver and, where relevant, the job. */
export class QueueError extends Error {
  override name = 'QueueError'
  readonly driver: string | undefined
  readonly job: string | undefined

  constructor(message: string, options: { driver?: string; job?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.driver = options.driver
    this.job = options.job
  }
}

/**
 * Raised when a handler exceeds its timeout.
 *
 * Distinct from any error the handler threw, because the two want different responses: a
 * timeout usually means a dependency is slow and retrying may work, where a thrown
 * `ValidationError` will fail identically every time.
 */
export class JobTimeout extends QueueError {
  override name = 'JobTimeout'
}
