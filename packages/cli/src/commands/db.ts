import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedArgs } from '../args'
import { resolveRoot } from '../paths'
import { BANNER, fail, info, style, success, warn } from '../ui'

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

  /**
   * `migrate` on Drizzle is run in-process rather than through drizzle-kit.
   *
   * drizzle-kit's SQLite migrator cannot use `bun:sqlite` — it asks for `better-sqlite3` or
   * `@libsql/client`, which means the default Oven stack could generate a migration and then not
   * apply it. Drizzle ships Bun-native migrators; this uses them, so the default stack needs no
   * native module.
   */
  if (sub === 'migrate' && toolchain.name === 'drizzle') {
    return migrateWithDrizzle(root)
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

/**
 * Applies generated migrations using Drizzle's Bun-native migrator.
 *
 * Reads the same `drizzle.config.ts` drizzle-kit does, so `generate` and `migrate` cannot
 * disagree about where migrations live or which database they target.
 */
async function migrateWithDrizzle(root: string): Promise<number> {
  const configPath = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs']
    .map((name) => join(root, name))
    .find((path) => existsSync(path))

  if (!configPath) {
    fail('No drizzle.config.ts found.', 'Create one, or run `bunx drizzle-kit migrate` yourself.')
    return 1
  }

  const config = ((await import(configPath)) as { default?: DrizzleConfig }).default
  const folder = config?.out ?? './drizzle'
  const url = config?.dbCredentials?.url

  if (!url) {
    fail(
      `${configPath} has no dbCredentials.url.`,
      'Oven needs it to connect. Set it, or run the migration through your own script.',
    )
    return 1
  }

  if (!existsSync(join(root, folder))) {
    fail(`No migrations found in ${folder}.`, 'Generate them first: oven db generate')
    return 1
  }

  info(style.dim(`  applying migrations from ${folder}`))

  try {
    if (config?.dialect === 'postgresql') {
      const { drizzle } = await import('drizzle-orm/bun-sql')
      const { migrate } = await import('drizzle-orm/bun-sql/migrator')
      const client = drizzle({ connection: { url } })
      await migrate(client, { migrationsFolder: join(root, folder) })
    } else {
      const { Database } = await import('bun:sqlite')
      const { drizzle } = await import('drizzle-orm/bun-sqlite')
      const { migrate } = await import('drizzle-orm/bun-sqlite/migrator')
      const client = drizzle(new Database(url))
      migrate(client, { migrationsFolder: join(root, folder) })
    }
  } catch (error) {
    fail('The migration failed.', error instanceof Error ? error.message : String(error))
    return 1
  }

  success('migrations applied')
  return 0
}

interface DrizzleConfig {
  out?: string
  dialect?: string
  dbCredentials?: { url?: string }
}
