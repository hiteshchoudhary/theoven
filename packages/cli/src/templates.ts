/**
 * Project templates.
 *
 * Held as data rather than as files on disk, for one reason: a published npm package must ship
 * its templates, and a directory of `.ts` files inside a package gets picked up by type checkers,
 * linters and test runners that then try to compile scaffolding they know nothing about.
 * Strings sidestep all of it.
 */

export type TemplateName = 'minimal' | 'api'

export interface TemplateFile {
  path: string
  contents: string
}

/**
 * The version range scaffolded projects depend on.
 *
 * Read from this package's own manifest rather than written here. It was hardcoded as `^0.0.0`,
 * which every published CLI then scaffolded — producing a project that could not `bun install`
 * at all. A literal version in a template is one that is correct exactly until the first
 * release.
 */
const OVEN_VERSION: string = `^${
  (
    (await Bun.file(new URL('../package.json', import.meta.url))
      .json()
      .catch(() => ({}))) as {
      version?: string
    }
  ).version ?? '0.1.0'
}`

export type DatabaseChoice = 'none' | 'sqlite' | 'postgres'
export type AuthChoice = 'none' | 'basic'

export interface TemplateOptions {
  name: string
  /** Include the OpenAPI brick and a `/docs` reference. */
  openapi: boolean
  /**
   * Drizzle over `bun:sqlite` or Postgres, or no database at all.
   *
   * Both write the same `src/db.ts` shape, so switching is one line and no query changes (D24).
   */
  database?: DatabaseChoice
  /** Scaffold `auth-basic`, which implies a database and mail. */
  auth?: AuthChoice
}

const GITIGNORE = `node_modules/
dist/
.oven/
*.tsbuildinfo
.env
.env.*
!.env.example
.DS_Store
`

const TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowJs": true,

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src/**/*"]
}
`

function packageJson(options: TemplateOptions): string {
  const hasDatabase = options.database !== undefined && options.database !== 'none'
  const hasAuth = options.auth === 'basic'

  const dependencies: Record<string, string> = {
    '@theoven/core': OVEN_VERSION,
    zod: '^4.0.0',
  }
  const devDependencies: Record<string, string> = {
    '@theoven/cli': OVEN_VERSION,
    '@types/bun': 'latest',
    typescript: '^5.9.0',
  }
  const scripts: Record<string, string> = {
    dev: 'oven dev',
    build: 'oven build',
    start: 'oven start',
    routes: 'oven routes',
    doctor: 'oven doctor',
  }

  if (hasDatabase) {
    dependencies['@theoven/db'] = OVEN_VERSION
    dependencies['@theoven/db-drizzle'] = OVEN_VERSION
    dependencies['drizzle-orm'] = '^0.45.0'
    devDependencies['drizzle-kit'] = '^0.31.0'
    scripts['db:generate'] = 'oven db generate'
    scripts['db:migrate'] = 'oven db migrate'
  }

  if (hasAuth) {
    dependencies['@theoven/auth'] = OVEN_VERSION
    dependencies['@theoven/auth-basic'] = OVEN_VERSION
    dependencies['@theoven/mail'] = OVEN_VERSION
  }

  return `${JSON.stringify(
    {
      name: options.name,
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts,
      dependencies,
      devDependencies,
    },
    null,
    2,
  )}\n`
}

function appModule(options: TemplateOptions): string {
  const hasDatabase = options.database !== undefined && options.database !== 'none'
  const hasAuth = options.auth === 'basic'

  const coreImports = ['createApp', 'loadRoutes', 'requestLogger', 'securityHeaders']
  if (options.openapi) coreImports.splice(3, 0, 'openapi')

  const imports = [`import { ${coreImports.sort().join(', ')} } from '@theoven/core'`]
  if (hasAuth) imports.push("import { auth } from '@theoven/auth'")
  if (hasAuth) imports.push("import { mail } from '@theoven/mail'")
  imports.push("import { config } from './env'")
  if (hasDatabase) imports.push("import { database } from './db'")
  if (hasAuth) imports.push("import { provider } from './auth'")
  if (hasAuth) imports.push("import { driver } from './mail'")

  // Order matters only where a brick depends on another; these read in the order they run.
  const bricks = ['  .use(requestLogger())', '  .use(securityHeaders())']
  if (hasDatabase) bricks.push('  .use(database)')
  if (hasAuth) bricks.push('  .use(mail(driver))')
  if (hasAuth) bricks.push('  .use(auth(provider))')
  if (options.openapi) {
    bricks.push(`  .use(openapi({ info: { title: '${options.name}', version: '0.1.0' } }))`)
  }

  return `${imports.join('\n')}

/**
 * The configured app.
 *
 * This module builds the app but never calls listen(), so \`oven routes\` and \`oven openapi\`
 * can import it without starting a server. Listening happens in index.ts.
 */
export const app = createApp({ logLevel: config.logLevel })
${bricks.join('\n')}

await loadRoutes(app, \`\${import.meta.dir}/routes\`)

export default app
`
}

const ENV_MODULE = `import { env, EnvError } from '@theoven/core'

/**
 * Configuration, read once.
 *
 * Bun loads .env, .env.local and .env.<NODE_ENV> already, so there is no dotenv here. These
 * readers throw when a value is missing or unparseable, rather than letting Boolean('false')
 * quietly mean true or Number('') quietly mean 0.
 *
 * For a larger surface, validate the whole environment at once with defineEnv and a schema.
 */
function read() {
  return {
    port: env.port('PORT', 3000),
    logLevel: env.oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info'),
    isProduction: env.isProduction,__EXTRA_ENV__
  }
}

/**
 * A bad variable is a configuration mistake, not a crash. Left to propagate, the runtime prints
 * a stack through library internals and buries the one line that names the variable, so it is
 * caught here and printed on its own.
 */
let loaded: ReturnType<typeof read>
try {
  loaded = read()
} catch (error) {
  if (error instanceof EnvError) {
    console.error(\`\\n\${error.message}\\n\`)
    process.exit(1)
  }
  throw error
}

export const config = loaded
`

const ENTRY = `import app from './app'
import { config } from './env'

await app.listen(config.port)

app.logger.info(\`listening on \${app.url}\`)
for (const { method, pattern } of app.routes()) {
  app.logger.info(\`  \${method.padEnd(6)} \${pattern}\`)
}
`

const ROOT_ROUTE = `export const summary = 'Service banner'

export default () => ({ status: 'ok' })
`

const HEALTH_ROUTE = `export const summary = 'Liveness probe'

export default () => ({ status: 'healthy', uptime: process.uptime() })
`

const STORE = `/**
 * Stand-in for a database.
 *
 * The leading underscore keeps this file out of the route table, which is how helpers live
 * beside the routes that use them.
 */
export interface User {
  id: string
  name: string
}

export const users = new Map<string, User>([
  ['1', { id: '1', name: 'Ada Lovelace' }],
  ['2', { id: '2', name: 'Grace Hopper' }],
])
`

const LIST_USERS = `import { defineRoute } from '@theoven/core'
import { z } from 'zod'
import { users } from './_store'

export default defineRoute(
  {
    summary: 'List users',
    tags: ['users'],
    query: z.object({ limit: z.coerce.number().min(1).max(100).default(20) }),
    response: { 200: z.array(z.object({ id: z.string(), name: z.string() })) },
  },
  // ctx.query.limit is a number here, inferred from the schema above.
  (ctx) => [...users.values()].slice(0, ctx.query.limit),
)
`

const CREATE_USER = `import { defineRoute } from '@theoven/core'
import { z } from 'zod'
import { users } from './_store'

export default defineRoute(
  {
    summary: 'Create a user',
    tags: ['users'],
    body: z.object({ name: z.string().min(1) }),
    response: { 201: z.object({ id: z.string(), name: z.string() }) },
  },
  (ctx) => {
    const id = String(users.size + 1)
    const user = { id, name: ctx.body.name }
    users.set(id, user)

    ctx.status = 201
    ctx.set('location', \`/users/\${id}\`)
    return user
  },
)
`

const GET_USER = `import { defineRoute, NotFound } from '@theoven/core'
import { z } from 'zod'
import { users } from './_store'

export default defineRoute(
  {
    summary: 'Fetch one user',
    tags: ['users'],
    params: z.object({ id: z.string() }),
    response: { 200: z.object({ id: z.string(), name: z.string() }) },
  },
  (ctx) => {
    const user = users.get(ctx.params.id)
    if (!user) throw new NotFound(\`No user with id \${ctx.params.id}\`)
    return user
  },
)
`

function readme(options: TemplateOptions): string {
  const stackLines: string[] = []
  if (options.database === 'sqlite') {
    stackLines.push('- **Database:** Drizzle over `bun:sqlite` (`src/schema.ts`, `src/db.ts`)')
  }
  if (options.database === 'postgres') {
    stackLines.push('- **Database:** Drizzle over Postgres (`src/schema.ts`, `src/db.ts`)')
  }
  if (options.auth === 'basic') {
    stackLines.push('- **Auth:** `auth-basic` — eight endpoints at `/auth/*`, rate limited')
    stackLines.push(
      '- **Mail:** the console driver, so password reset works before you configure one',
    )
  }
  const stack = stackLines.length > 0 ? `\n## Stack\n\n${stackLines.join('\n')}\n` : ''

  const docsLine = options.openapi
    ? '\nAn API reference is served at `/docs`, generated from the schemas in each route file.\n'
    : ''

  return `# ${options.name}

Built with [Oven](https://theoven.app).

\`\`\`bash
bun install${
    options.database && options.database !== 'none'
      ? `
cp .env.example .env
bun run db:generate && bun run db:migrate`
      : ''
  }
bun run dev
\`\`\`
${docsLine}${stack}
## Layout

\`\`\`
src/
  env.ts       configuration, read and validated once
  app.ts       builds and exports the app (never listens)
  index.ts     starts the server
  routes/      the route table — the filesystem is the router
\`\`\`

\`app.ts\` and \`index.ts\` are separate so \`oven routes\` and \`oven openapi\` can inspect the
app without binding a port.

## Commands

| Command | What it does |
| --- | --- |
| \`bun run dev\` | run with a watcher |
| \`bun run build\` | bundle and write a route manifest |
| \`bun run start\` | run the build |
| \`bun run routes\` | print the route table |
| \`bun run doctor\` | check the project for common problems |
`
}

// ---------------------------------------------------------------------------------------
// Database, auth and mail
// ---------------------------------------------------------------------------------------

function schemaModule(options: TemplateOptions): string {
  const authTables =
    options.auth === 'basic'
      ? `
/**
 * The tables \`auth-basic\` owns: \`auth_users\`, \`auth_refresh_tokens\`, \`auth_reset_tokens\`.
 *
 * Re-exported here so \`oven db generate\` writes migrations for them alongside your own. Drop
 * this line and signup fails at runtime with "no such table: auth_users".
 */
export * from '@theoven/auth-basic/schema'
`
      : ''

  return `${SCHEMA}${authTables}`
}

const SCHEMA = `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Your tables.
 *
 * Switching to Postgres means importing from \`drizzle-orm/pg-core\` here and changing one line
 * in db.ts. Every query you write against \`ctx.db\` stays exactly the same.
 */
export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})
`

function dbModule(choice: DatabaseChoice): string {
  const provider =
    choice === 'postgres'
      ? 'drizzlePostgres({ url: config.databaseUrl, schema })'
      : 'drizzleSqlite({ url: config.databaseUrl, schema })'

  const other = choice === 'postgres' ? 'drizzleSqlite' : 'drizzlePostgres'
  const otherCall =
    choice === 'postgres'
      ? 'drizzleSqlite({ url: config.databaseUrl, schema })'
      : 'drizzlePostgres({ url: config.databaseUrl, schema })'

  return `import { db } from '@theoven/db'
import { ${choice === 'postgres' ? 'drizzlePostgres' : 'drizzleSqlite'} } from '@theoven/db-drizzle'
import { config } from './env'
import * as schema from './schema'

/**
 * The database brick.
 *
 * \`ctx.db\` is the Drizzle client itself, typed from the schema above — not a wrapper. Your
 * queries are Drizzle queries, which is also why a model already knows how to write them.
 *
 * The one-line switch:
 *
 *   import { ${other} } from '@theoven/db-drizzle'
 *   export const database = db(${otherCall})
 *
 * Change the import and this line. Every query stays the same.
 */
export const database = db(${provider})
`
}

const AUTH_MODULE = `import { basicAuth } from '@theoven/auth-basic'
import { client } from './client'
import { config } from './env'

/**
 * Email-and-password auth.
 *
 * Mounts eight endpoints at /auth/*: signup, login, refresh, logout, me, change-password,
 * forgot-password and reset-password. Login, signup and reset are rate limited by default.
 *
 * The reset email goes through ctx.mail. In development that is the console driver, so the link
 * is printed to the terminal and the whole flow works before you have configured a provider.
 */
export const provider = basicAuth({
  db: client,
  secret: config.authSecret,
  sendResetEmail: async (to, token) => {
    const { mailer } = await import('./mail')
    await mailer.send({
      to,
      subject: 'Reset your password',
      text: \`Open \${config.appUrl}/reset?token=\${token}\`,
    })
  },
})
`

const AUTH_CLIENT = `import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { config } from './env'
import * as schema from './schema'

/**
 * The raw Drizzle client, for the pieces that need one before the app exists.
 *
 * \`auth-basic\` takes a client rather than reading it off the context, because it builds its
 * store at construction. Inside a route, keep using \`ctx.db\` — it is this same client.
 */
export const client = drizzle(new Database(config.databaseUrl), { schema })
`

const MAIL_MODULE = `import { consoleMail } from '@theoven/mail'

/**
 * Mail, defaulting to the console driver.
 *
 * Password reset works immediately: the link is printed to your terminal. Swap in a real driver
 * when you have one — the console driver is refused in production, so this cannot ship by
 * accident.
 *
 *   import { resendMail } from '@theoven/mail'
 *   export const driver = resendMail({ apiKey: env.string('RESEND_API_KEY') })
 */
export const driver = consoleMail()

export const mailer = {
  send: (message: Parameters<typeof driver.send>[0]) => driver.send(message),
}
`

const ME_ROUTE = `import { defineRoute } from '@theoven/core'

/** The guard is what narrows ctx.user: inside this handler it cannot be null. */
export default defineRoute(
  { auth: true, summary: 'The signed-in user' },
  (ctx) => ({ id: ctx.user.id, email: ctx.user.email, name: ctx.user.name }),
)
`

const DRIZZLE_CONFIG_SQLITE = `import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: process.env.DATABASE_URL ?? './data.db' },
})
`

const DRIZZLE_CONFIG_POSTGRES = `import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL as string },
})
`

/**
 * Instructions for coding agents, written into every project.
 *
 * A model that has not read Oven's docs will otherwise reach for Express habits — `res.json`,
 * `require`, middleware signatures with three arguments. Stating the conventions once, in the
 * file agents look for, is cheaper than correcting them per session (D22).
 */
function agentsFile(options: TemplateOptions): string {
  const dbSection =
    options.database && options.database !== 'none'
      ? `
## Database

- \`ctx.db\` is the **Drizzle client**, typed from \`src/schema.ts\`. Write ordinary Drizzle
  queries: \`await ctx.db.select().from(notes)\`. There is no Oven query API to learn.
- Add tables in \`src/schema.ts\`, then run \`oven db generate\` and \`oven db migrate\`.
- For a transaction, \`import { transaction } from '@theoven/db'\` or use Drizzle's own form.
`
      : ''

  const authSection =
    options.auth === 'basic'
      ? `
## Auth

- The endpoints at \`/auth/*\` come from \`auth-basic\`. Do not write your own signup or login.
- Guard a route with \`{ auth: true }\` in its schema. Inside such a route \`ctx.user\` is
  non-null — no null check needed, and TypeScript knows.
- For a rule beyond "signed in", add a named policy and use \`{ auth: 'policy-name' }\`.
- Never read or log \`passwordHash\`.
`
      : ''

  return `# Working in this project

This is an [Oven](https://theoven.app) app. Oven is not Express — the conventions below are not
stylistic preferences, they are what the framework expects.

## Routes

- The filesystem is the router. \`src/routes/users/[id].get.ts\` serves \`GET /users/:id\`.
- A route file default-exports a handler. Use \`defineRoute(schema, handler)\` when it has a
  schema — that is what makes \`ctx.params\`, \`ctx.query\` and \`ctx.body\` typed and what
  puts the route in the OpenAPI document.
- **Return values.** Return a plain object and Oven serialises it. There is no \`res\`, no
  \`res.json()\`, no \`next()\`. Return \`null\` for 204. Set \`ctx.status\` to change the code.
- **Errors.** \`throw new NotFound('...')\` and friends from \`@theoven/core\`. They become
  RFC 9457 problem+json. Do not hand-write error responses.
- Validation is [Standard Schema](https://standardschema.dev), so Zod works and so does Valibot.
  A failed validation is a 422 naming the field; you do not write that check.
${dbSection}${authSection}
## Never

- **No Express middleware.** \`(req, res, next)\` does not work here. Oven middleware is
  \`(ctx, next) => ...\` and returns a Response.
- **No CommonJS.** ESM only — \`import\`, never \`require\`.
- **No \`process.env\` reads scattered through the code.** Add it to \`src/env.ts\`, where a
  missing variable fails at boot with a message instead of at 3am as \`undefined\`.
- **No \`any\` to silence an inference problem.** The types are the documentation; if one is
  wrong, that is worth knowing.

## Commands

\`\`\`bash
bun run dev       # watcher
bun run routes    # print the route table — use this to check what you registered
bun run doctor    # configuration problems, with what to do about each
\`\`\`

Full documentation: https://theoven.app/docs — and https://theoven.app/llms.txt for a
model-readable index of it.
`
}

/** Builds the file list for a template. */
export function renderTemplate(template: TemplateName, options: TemplateOptions): TemplateFile[] {
  const database = options.database ?? 'none'
  // Auth needs somewhere to put users. Choosing SQLite silently is better than a scaffold that
  // does not run, and the README says which database it picked.
  const resolved: TemplateOptions = {
    ...options,
    database: options.auth === 'basic' && database === 'none' ? 'sqlite' : database,
  }
  const hasDatabase = resolved.database !== 'none'
  const hasAuth = resolved.auth === 'basic'

  const files: TemplateFile[] = [
    { path: 'package.json', contents: packageJson(resolved) },
    { path: 'tsconfig.json', contents: TSCONFIG },
    { path: '.gitignore', contents: GITIGNORE },
    { path: '.env.example', contents: envExample(resolved) },
    { path: 'README.md', contents: readme(resolved) },
    { path: 'AGENTS.md', contents: agentsFile(resolved) },
    { path: 'src/env.ts', contents: envModule(resolved) },
    { path: 'src/app.ts', contents: appModule(resolved) },
    { path: 'src/index.ts', contents: ENTRY },
    { path: 'src/routes/index.get.ts', contents: ROOT_ROUTE },
  ]

  if (hasDatabase) {
    files.push(
      { path: 'src/schema.ts', contents: schemaModule(resolved) },
      { path: 'src/db.ts', contents: dbModule(resolved.database as DatabaseChoice) },
      {
        path: 'drizzle.config.ts',
        contents:
          resolved.database === 'postgres' ? DRIZZLE_CONFIG_POSTGRES : DRIZZLE_CONFIG_SQLITE,
      },
    )
  }

  if (hasAuth) {
    files.push(
      { path: 'src/client.ts', contents: AUTH_CLIENT },
      { path: 'src/mail.ts', contents: MAIL_MODULE },
      { path: 'src/auth.ts', contents: AUTH_MODULE },
      { path: 'src/routes/me.get.ts', contents: ME_ROUTE },
    )
  }

  if (template === 'api') {
    files.push(
      { path: 'src/routes/health.get.ts', contents: HEALTH_ROUTE },
      { path: 'src/routes/users/_store.ts', contents: STORE },
      { path: 'src/routes/users/index.get.ts', contents: LIST_USERS },
      { path: 'src/routes/users/index.post.ts', contents: CREATE_USER },
      { path: 'src/routes/users/[id].get.ts', contents: GET_USER },
    )
  }

  return files
}

/**
 * `.env.example` lists every variable the scaffold reads.
 *
 * Generated from the same choices as the code, so a scaffold cannot ship a `src/env.ts` that
 * demands a variable the example file never mentions.
 */
function envExample(options: TemplateOptions): string {
  const lines = ['# Copy to .env and adjust.', 'PORT=3000', 'LOG_LEVEL=info']

  if (options.database === 'sqlite') lines.push('DATABASE_URL=./data.db')
  if (options.database === 'postgres') {
    lines.push('DATABASE_URL=postgres://user:password@localhost:5432/' + options.name)
  }
  if (options.auth === 'basic') {
    lines.push(
      '',
      '# Signs access tokens. Generate one: openssl rand -base64 32',
      'AUTH_SECRET=',
      '# Used in password-reset links.',
      'APP_URL=http://localhost:3000',
    )
  }

  return `${lines.join('\n')}\n`
}

function envModule(options: TemplateOptions): string {
  const extra: string[] = []
  if (options.database === 'postgres') {
    extra.push("    databaseUrl: env.string('DATABASE_URL'),")
  } else if (options.database === 'sqlite') {
    extra.push("    databaseUrl: env.string('DATABASE_URL', './data.db'),")
  }
  if (options.auth === 'basic') {
    // No default. A framework that invents a signing secret has invented one every deployment
    // shares, so this must fail at boot when it is missing.
    extra.push("    authSecret: env.string('AUTH_SECRET'),")
    extra.push("    appUrl: env.string('APP_URL', 'http://localhost:3000'),")
  }

  return ENV_MODULE.replace('__EXTRA_ENV__', extra.length > 0 ? `\n${extra.join('\n')}` : '')
}

export const TEMPLATES: Record<TemplateName, string> = {
  minimal: 'One route, nothing else',
  api: 'A small REST API with validation, uploads-ready schemas and OpenAPI',
}
