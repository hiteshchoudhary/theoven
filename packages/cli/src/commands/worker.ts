import type { ParsedArgs } from '../args'
import { stringFlag } from '../args'
import { loadApp } from '../load'
import { CANDIDATES, resolveAppModule, resolveRoot } from '../paths'
import { BANNER, fail, info, style, success } from '../ui'

/**
 * `oven worker` — runs background jobs, and nothing else.
 *
 * Imports the **app module** rather than the entry, so it gets every brick the app configured —
 * the same database, the same mail driver, the same job definitions — without binding a port.
 * A worker that had to be configured separately from the app is a worker that drifts from it.
 */
export async function worker(args: ParsedArgs): Promise<number> {
  const root = resolveRoot()
  const file = resolveAppModule(root, stringFlag(args.flags, 'app'))

  if (!file) {
    fail(
      'No app module found.',
      `Looked for ${CANDIDATES.app.join(', ')}. It should export the configured app without ` +
        'calling listen(). Pass one with --app <path>.',
    )
    return 1
  }

  const app = await loadApp(file)
  if (!app) return 1

  let service: QueueLike | undefined
  try {
    await app.ready()
    service = app.service('queue') as QueueLike
  } catch {
    service = undefined
  }

  if (!service) {
    fail(
      'This app has no queue brick.',
      'Add one: app.use(queue(memoryQueue(), { jobs: [...] })). See https://theoven.app/docs/bricks/queue/',
    )
    await app.close({ timeout: 0 })
    return 1
  }

  const concurrency = Number(stringFlag(args.flags, 'concurrency') ?? 5)
  const once = args.flags.once === true

  info(`${BANNER} ${style.dim('worker')}`)
  info('')
  info(`  driver       ${style.cyan(service.driver)}`)
  info(`  concurrency  ${style.cyan(String(concurrency))}`)
  info('')

  /**
   * The app's own worker is stopped first when one is running.
   *
   * Otherwise `oven worker` and the in-process worker both poll the same queue from one
   * process, doubling the configured concurrency for no reason anyone asked for.
   */
  await service.worker?.stop()

  const { createWorker } = (await import('@theoven/queue')) as typeof import('@theoven/queue')
  const runner = createWorker(service.raw as never, service.jobs as never, {
    concurrency,
    logger: app.logger,
  })

  if (once) {
    // For a cron container or a CI step: drain what is there and exit, rather than idling.
    const processed = await runner.drain()
    success(`processed ${processed} job(s)`)
    await app.close({ timeout: 0 })
    return 0
  }

  runner.start()
  info(style.dim('  waiting for jobs — ctrl-c to stop'))

  let stopping = false
  const shutdown = async () => {
    // A second ctrl-c during a drain should not start a second drain.
    if (stopping) return
    stopping = true

    info('')
    info(style.dim(`  draining ${runner.running} job(s) in flight`))
    await runner.stop()
    await app.close({ timeout: 5000 })
    success('stopped')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // Resolves only on a signal; the command is a long-running process by design.
  await new Promise(() => {})
  return 0
}

interface QueueLike {
  driver: string
  raw: unknown
  /**
   * The job map, read off the brick rather than re-declared.
   *
   * A worker that knew a different set of jobs from the app enqueueing them would dead-letter
   * everything it did not recognise, which is a confusing way to discover a stale deploy.
   */
  jobs: unknown
  worker?: { stop(): Promise<void> } | undefined
}
