import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { boolFlag, type ParsedArgs, stringFlag } from '../args'
import {
  type AuthChoice,
  type DatabaseChoice,
  renderTemplate,
  TEMPLATES,
  type TemplateName,
} from '../templates'

const DATABASE_CHOICES: readonly DatabaseChoice[] = ['none', 'sqlite', 'postgres']
const AUTH_CHOICES: readonly AuthChoice[] = ['none', 'basic']

import { BANNER, fail, info, style, success, warn } from '../ui'

/**
 * `oven create <name>`.
 *
 * Interactive when attached to a TTY, flag-driven otherwise. The distinction matters: a
 * scaffolder that prompts inside CI hangs forever, which is a bad way to discover that a
 * pipeline is misconfigured.
 */

/** Project names become directory names and a package name, so they cannot be arbitrary. */
export function validateProjectName(name: string): string | null {
  if (name.trim() === '') return 'A project name is required.'
  if (name.length > 214) return 'Project names must be 214 characters or fewer.'
  if (name.startsWith('.') || name.startsWith('_')) {
    return 'Project names cannot start with "." or "_".'
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return 'Use lowercase letters, digits, hyphens, dots and underscores only.'
  }
  return null
}

/** A directory that exists and is non-empty would be silently overwritten. */
export async function checkTarget(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null
  const entries = await readdir(dir)
  const meaningful = entries.filter((entry) => entry !== '.git' && entry !== '.DS_Store')
  return meaningful.length > 0 ? `${dir} already exists and is not empty.` : null
}

async function prompt(question: string, fallback: string): Promise<string> {
  process.stdout.write(`${question} ${style.dim(`(${fallback})`)} `)

  for await (const line of console) {
    const answer = line.trim()
    return answer === '' ? fallback : answer
  }
  return fallback
}

async function confirm(question: string, fallback: boolean): Promise<boolean> {
  const answer = await prompt(`${question} ${style.dim(fallback ? '[Y/n]' : '[y/N]')}`, '')
  if (answer === '') return fallback
  return answer.toLowerCase().startsWith('y')
}

export async function create(args: ParsedArgs): Promise<number> {
  const interactive = process.stdin.isTTY === true && !boolFlag(args.flags, 'yes')

  info(`${BANNER} ${style.dim('create')}`)
  info('')

  let name = args.positionals[0] ?? stringFlag(args.flags, 'name')
  if (!name && interactive) name = await prompt('Project name?', 'my-app')
  name ??= 'my-app'

  const nameProblem = validateProjectName(name)
  if (nameProblem) {
    fail(nameProblem)
    return 1
  }

  let template = stringFlag(args.flags, 'template') as TemplateName | undefined
  if (!template && interactive) {
    info('')
    for (const [key, description] of Object.entries(TEMPLATES)) {
      info(`  ${style.cyan(key.padEnd(8))} ${style.dim(description)}`)
    }
    info('')
    template = (await prompt('Template?', 'api')) as TemplateName
  }
  template ??= 'api'

  if (!(template in TEMPLATES)) {
    fail(`Unknown template "${template}".`, `Available: ${Object.keys(TEMPLATES).join(', ')}`)
    return 1
  }

  const openapi = interactive
    ? await confirm('Include OpenAPI docs at /docs?', true)
    : boolFlag(args.flags, 'openapi', true)

  let database = stringFlag(args.flags, 'db') as DatabaseChoice | undefined
  if (!database && interactive) {
    info('')
    info(
      `  ${style.cyan('sqlite'.padEnd(10))} ${style.dim('Drizzle over bun:sqlite — no server to run')}`,
    )
    info(`  ${style.cyan('postgres'.padEnd(10))} ${style.dim('Drizzle over Postgres')}`)
    info(`  ${style.cyan('none'.padEnd(10))} ${style.dim('no database')}`)
    info('')
    database = (await prompt('Database?', 'sqlite')) as DatabaseChoice
  }
  database ??= 'none'

  if (!DATABASE_CHOICES.includes(database)) {
    fail(`Unknown database "${database}".`, `Available: ${DATABASE_CHOICES.join(', ')}`)
    return 1
  }

  let auth = stringFlag(args.flags, 'auth') as AuthChoice | undefined
  if (!auth && interactive) {
    auth = (await confirm('Scaffold email and password auth?', false)) ? 'basic' : 'none'
  }
  auth ??= 'none'

  if (!AUTH_CHOICES.includes(auth)) {
    fail(`Unknown auth option "${auth}".`, `Available: ${AUTH_CHOICES.join(', ')}`)
    return 1
  }

  // Auth needs somewhere to put users. Say so rather than scaffolding something that will not
  // run, or silently changing an answer the user gave.
  if (auth === 'basic' && database === 'none') {
    warn('auth-basic needs a database; scaffolding with SQLite.')
    database = 'sqlite'
  }

  const target = resolve(process.cwd(), name)
  const targetProblem = await checkTarget(target)
  if (targetProblem) {
    fail(targetProblem, 'Choose another name, or remove the directory first.')
    return 1
  }

  const files = renderTemplate(template, { name, openapi, database, auth })

  for (const file of files) {
    const full = join(target, file.path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, file.contents)
  }

  info('')
  success(`created ${style.bold(name)} ${style.dim(`(${files.length} files, ${template})`)}`)
  info('')
  info('  Next:')
  info(style.dim(`    cd ${name}`))
  info(style.dim('    bun install'))
  if (database !== 'none') {
    // Without this the first request that touches a table fails with "no such table", which
    // reads like a bug in the scaffold rather than a step nobody was told about.
    info(style.dim('    cp .env.example .env'))
    info(style.dim('    bun run db:generate && bun run db:migrate'))
  }
  info(style.dim('    bun run dev'))
  info('')

  return 0
}
