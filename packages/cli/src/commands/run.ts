import { spawn } from 'bun'
import { type ParsedArgs, stringFlag } from '../args'
import { CANDIDATES, resolveEntry, resolveRoot } from '../paths'
import { BANNER, fail, info, style } from '../ui'

/**
 * `oven dev` and `oven start`.
 *
 * Both hand off to a child `bun` process rather than importing the app here. The CLI's own
 * module graph would otherwise become part of the app's — its dependencies visible to user
 * code, its crashes indistinguishable from the app's — and there would be no way to restart on
 * a file change without restarting the CLI too.
 */

function missingEntry(): void {
  fail(
    'No entry file found.',
    `Looked for ${CANDIDATES.entry.join(', ')}. Pass one with --entry <path>.`,
  )
}

/**
 * Runs the app with a watcher.
 *
 * `bun --watch` restarts the process on change rather than `--hot`, which patches modules in
 * place. In-place patching leaves a server bound to the port and brick state half-initialised
 * from the previous version; a clean restart takes single-digit milliseconds in Bun and has no
 * such failure mode. The correctness is worth far more than the milliseconds.
 */
export async function dev(args: ParsedArgs): Promise<number> {
  const root = resolveRoot()
  const entry = resolveEntry(root, stringFlag(args.flags, 'entry'))

  if (!entry) {
    missingEntry()
    return 1
  }

  const port = stringFlag(args.flags, 'port')

  info(`${BANNER} ${style.dim('dev')}`)
  info(style.dim(`  watching ${entry.replace(`${root}/`, '')}`))
  info('')

  const child = spawn({
    cmd: ['bun', '--watch', entry],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ...(port ? { PORT: port } : {}),
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  // Forward signals so Ctrl-C reaches the app and its graceful shutdown actually runs.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal === 'SIGINT' ? 2 : 15)
  process.on('SIGINT', forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))

  return await child.exited
}

/** Runs the built output, or the entry directly when there is no build. */
export async function start(args: ParsedArgs): Promise<number> {
  const root = resolveRoot()
  const built = Bun.file(`${root}/dist/index.js`)

  const target = (await built.exists())
    ? `${root}/dist/index.js`
    : resolveEntry(root, stringFlag(args.flags, 'entry'))

  if (!target) {
    missingEntry()
    return 1
  }

  if (!target.includes('/dist/')) {
    // Running from source in production works, but it means no route manifest and no bundle,
    // so the filesystem is scanned at every cold start. Worth saying once.
    info(style.dim('No build found; running from source. Run `oven build` first for production.'))
  }

  const port = stringFlag(args.flags, 'port')

  const child = spawn({
    cmd: ['bun', target],
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      ...(port ? { PORT: port } : {}),
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  const forward = (signal: NodeJS.Signals) => () => child.kill(signal === 'SIGINT' ? 2 : 15)
  process.on('SIGINT', forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))

  return await child.exited
}
