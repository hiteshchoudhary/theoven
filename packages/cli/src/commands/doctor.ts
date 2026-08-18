import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ParsedArgs } from '../args'
import { CANDIDATES, resolveAppModule, resolveEntry, resolveRoot, resolveRoutesDir } from '../paths'
import { BANNER, info, style } from '../ui'

/**
 * `oven doctor`.
 *
 * Checks the things that are cheap to verify now and expensive to discover later: a Bun too old
 * for the APIs core uses, a missing entry, a port already taken. Each check reports what it
 * found *and* what to do about it — a diagnostic that only says "problem" has done half the job.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
  /** What to do about it. Present whenever the status is not `ok`. */
  hint?: string
}

/** Minimum Bun the framework's APIs require. `Bun.S3Client` and text lockfiles both land here. */
export const MINIMUM_BUN = '1.2.0'

/** Compares dotted version strings. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

export function checkBunVersion(version: string): CheckResult {
  const ok = compareVersions(version, MINIMUM_BUN) >= 0
  return ok
    ? { name: 'Bun version', status: 'ok', detail: version }
    : {
        name: 'Bun version',
        status: 'fail',
        detail: `${version} is older than ${MINIMUM_BUN}`,
        hint: 'Run `bun upgrade`.',
      }
}

export function checkEntry(root: string, override?: string): CheckResult {
  const entry = resolveEntry(root, override)
  return entry
    ? { name: 'Entry', status: 'ok', detail: relative(root, entry) }
    : {
        name: 'Entry',
        status: 'fail',
        detail: 'not found',
        hint: `Create one of ${CANDIDATES.entry.join(', ')}, or pass --entry.`,
      }
}

export function checkAppModule(root: string, override?: string): CheckResult {
  const app = resolveAppModule(root, override)
  return app
    ? { name: 'App module', status: 'ok', detail: relative(root, app) }
    : {
        name: 'App module',
        status: 'warn',
        detail: 'not found',
        hint:
          'Export the app from src/app.ts without calling listen(). Without it, ' +
          '`oven routes` and `oven openapi` cannot inspect the app without starting a server.',
      }
}

export function checkRoutes(root: string, override?: string): CheckResult {
  const dir = resolveRoutesDir(root, override)
  return dir
    ? { name: 'Routes', status: 'ok', detail: relative(root, dir) }
    : {
        name: 'Routes',
        status: 'warn',
        detail: 'no routes directory',
        hint: 'File-based routing looks in src/routes. Programmatic routes work without it.',
      }
}

export function checkEnvFile(root: string): CheckResult {
  const hasEnv = existsSync(join(root, '.env'))
  const hasExample = existsSync(join(root, '.env.example'))

  if (hasEnv && !hasExample) {
    return {
      name: 'Environment',
      status: 'warn',
      detail: '.env present, .env.example missing',
      hint: 'Commit a .env.example so a new contributor knows which variables to set.',
    }
  }
  if (!hasEnv && hasExample) {
    return {
      name: 'Environment',
      status: 'warn',
      detail: '.env.example present, .env missing',
      hint: 'Copy it: cp .env.example .env',
    }
  }
  return {
    name: 'Environment',
    status: 'ok',
    detail: hasEnv ? '.env present' : 'no .env needed',
  }
}

/** Checks whether a port can be bound, which is the usual reason `oven dev` fails to start. */
export async function checkPort(port: number): Promise<CheckResult> {
  try {
    const server = Bun.serve({ port, fetch: () => new Response('') })
    server.stop(true)
    return { name: 'Port', status: 'ok', detail: `${port} is free` }
  } catch {
    return {
      name: 'Port',
      status: 'warn',
      detail: `${port} is in use`,
      hint: 'Stop whatever is holding it, or run with --port <other>.',
    }
  }
}

/** Everything `doctor` checks, as data — so the checks can be tested without running the CLI. */
export async function runChecks(
  root: string,
  options: { bunVersion: string; port: number } = { bunVersion: Bun.version, port: 3000 },
): Promise<CheckResult[]> {
  return [
    checkBunVersion(options.bunVersion),
    checkEntry(root),
    checkAppModule(root),
    checkRoutes(root),
    checkEnvFile(root),
    await checkPort(options.port),
  ]
}

const MARK: Record<CheckStatus, string> = {
  ok: style.green('✓'),
  warn: style.yellow('!'),
  fail: style.red('✗'),
}

export async function doctor(args: ParsedArgs): Promise<number> {
  const root = resolveRoot()
  const port = Number(args.flags.port ?? Bun.env.PORT ?? 3000)

  info(`${BANNER} ${style.dim('doctor')}`)
  info('')

  const results = await runChecks(root, { bunVersion: Bun.version, port })
  const width = Math.max(...results.map((result) => result.name.length))

  for (const result of results) {
    info(`  ${MARK[result.status]} ${result.name.padEnd(width)}  ${style.dim(result.detail)}`)
    if (result.hint) info(`    ${style.dim(result.hint)}`)
  }

  const failures = results.filter((result) => result.status === 'fail').length
  const warnings = results.filter((result) => result.status === 'warn').length

  info('')
  if (failures > 0) {
    info(`  ${style.red(`${failures} problem(s)`)}, ${warnings} warning(s)`)
    return 1
  }
  info(
    warnings > 0 ? `  ${style.yellow(`${warnings} warning(s)`)}` : `  ${style.green('all good')}`,
  )
  return 0
}
