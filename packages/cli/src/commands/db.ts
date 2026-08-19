import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedArgs } from '../args'
import { resolveRoot } from '../paths'
import { BANNER, fail, info, style, warn } from '../ui'

/**
 * `oven db` — schema and migration commands.
 *
 * These delegate to the migration tool your database adapter uses rather than reimplementing it.
 * Drizzle's migration generator understands Drizzle schemas better than anything we would write,
 * and a wrapper that reimplemented it would drift from it within a release.
 *
 * What Oven adds is the part that is genuinely missing: one command name that works whatever
 * adapter the project uses, and an error that tells you what to install when it does not.
 */

/** Subcommands, and what each one does, in the order a project uses them. */
const SUBCOMMANDS = {
  generate: 'write a migration from the current schema',
  migrate: 'apply pending migrations',
  push: 'push the schema straight to the database (development only)',
  studio: 'open the database browser',
  drop: 'drop a generated migration',
} as const

export type Subcommand = keyof typeof SUBCOMMANDS

export function isSubcommand(value: string | undefined): value is Subcommand {
  return value !== undefined && value in SUBCOMMANDS
}

/**
 * Config files that identify the toolchain, most specific first.
 *
 * Detected from the file rather than from `package.json`, because the config is what the
 * underlying tool actually needs — a project with the dependency but no config gets a clearer
 * error this way.
 */
const TOOLCHAINS = [
  {
    name: 'drizzle',
    configs: ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs'],
    binary: 'drizzle-kit',
    install: 'bun add -d drizzle-kit',
    // drizzle-kit names two of them differently from us.
    translate: (sub: Subcommand): string | null => sub,
  },
  {
    name: 'prisma',
    configs: ['prisma/schema.prisma', 'schema.prisma'],
    binary: 'prisma',
    install: 'bun add -d prisma',
    translate: (sub: Subcommand): string | null =>
      ({
        generate: 'migrate dev --create-only',
        migrate: 'migrate deploy',
        push: 'db push',
        studio: 'studio',
        drop: null,
      })[sub],
  },
] as const

type Toolchain = (typeof TOOLCHAINS)[number]

/**
 * Identifies the migration toolchain a project uses, or `undefined`.
 *
 * Separate from the command so it can be tested without spawning anything.
 */
export function detectToolchain(root: string): Toolchain | undefined {
  return TOOLCHAINS.find((candidate) =>
    candidate.configs.some((config) => existsSync(join(root, config))),
  )
}

export async function dbCommand(args: ParsedArgs): Promise<number> {
  const [sub, ...rest] = args.positionals

  if (!isSubcommand(sub)) {
    info(`${BANNER} ${style.dim('db')}`)
    info('')
    info(`  ${style.bold('Usage')}  oven db <command> [-- <tool flags>]`)
    info('')
    for (const [name, description] of Object.entries(SUBCOMMANDS)) {
      info(`  ${style.cyan(name.padEnd(10))} ${style.dim(description)}`)
    }
    info('')
    info(style.dim('  Anything after `--` is passed to the migration tool unchanged.'))
    return sub ? 1 : 0
  }

  const root = resolveRoot()
  const toolchain = detectToolchain(root)

  if (!toolchain) {
    fail(
      'No database toolchain found in this project.',
      'Expected one of: ' +
        TOOLCHAINS.flatMap((candidate) => candidate.configs).join(', ') +
        '. See https://theoven.app/docs/bricks/db-drizzle/ to set one up.',
    )
    return 1
  }

  const translated = toolchain.translate(sub)
  if (translated === null) {
    fail(
      `\`oven db ${sub}\` has no equivalent in ${toolchain.name}.`,
      `Available here: ${(Object.keys(SUBCOMMANDS) as Subcommand[])
        .filter((name) => toolchain.translate(name) !== null)
        .join(', ')}.`,
    )
    return 1
  }

  // `push` rewrites the schema in place with no migration to review or roll back. Fine against a
  // development database, and the reason production deploys should run `migrate`.
  if (sub === 'push' && process.env.NODE_ENV === 'production') {
    warn(
      '`db push` applies schema changes without a migration. Use `oven db migrate` in production.',
    )
  }

  const command = ['bunx', toolchain.binary, ...translated.split(' '), ...rest]
  info(style.dim(`  ${command.join(' ')}`))

  const child = Bun.spawn(command, { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] })
  const code = await child.exited

  // Exit code 127 is the shell's "not found" — the dependency is missing, which we can fix
  // with a sentence rather than leaving the user to read bunx's output.
  if (code === 127) {
    fail(`${toolchain.binary} is not installed.`, `Install it with: ${toolchain.install}`)
    return 1
  }

  return code
}
