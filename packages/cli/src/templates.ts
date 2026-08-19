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

export interface TemplateOptions {
  name: string
  /** Include the OpenAPI brick and a `/docs` reference. */
  openapi: boolean
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

function packageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: {
        dev: 'oven dev',
        build: 'oven build',
        start: 'oven start',
        routes: 'oven routes',
        doctor: 'oven doctor',
      },
      dependencies: {
        '@theoven/core': '^0.0.0',
        zod: '^4.0.0',
      },
      devDependencies: {
        '@theoven/cli': '^0.0.0',
        '@types/bun': 'latest',
        typescript: '^5.9.0',
      },
    },
    null,
    2,
  )}\n`
}

/**
 * The app module: builds and exports, but does not listen.
 *
 * Split from the entry on purpose. `oven routes` and `oven openapi` import this to inspect the
 * app, and if listening happened here, asking for a route table would bind a port.
 */
function appModule(options: TemplateOptions): string {
  const imports = options.openapi
    ? "import { createApp, loadRoutes, openapi, requestLogger, securityHeaders } from '@theoven/core'"
    : "import { createApp, loadRoutes, requestLogger, securityHeaders } from '@theoven/core'"

  const bricks = options.openapi
    ? `  .use(requestLogger())
  .use(securityHeaders())
  .use(openapi({ info: { title: '${options.name}', version: '0.1.0' } }))`
    : `  .use(requestLogger())
  .use(securityHeaders())`

  return `${imports}
import { config } from './env'

/**
 * The configured app.
 *
 * This module builds the app but never calls listen(), so \`oven routes\` and \`oven openapi\`
 * can import it without starting a server. Listening happens in index.ts.
 */
export const app = createApp({ logLevel: config.logLevel })
${bricks}

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
    isProduction: env.isProduction,
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
  const docsLine = options.openapi
    ? '\nAn API reference is served at `/docs`, generated from the schemas in each route file.\n'
    : ''

  return `# ${options.name}

Built with [Oven](https://theoven.app).

\`\`\`bash
bun install
bun run dev
\`\`\`
${docsLine}
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

/** Builds the file list for a template. */
export function renderTemplate(template: TemplateName, options: TemplateOptions): TemplateFile[] {
  const files: TemplateFile[] = [
    { path: 'package.json', contents: packageJson(options.name) },
    { path: 'tsconfig.json', contents: TSCONFIG },
    { path: '.gitignore', contents: GITIGNORE },
    { path: '.env.example', contents: '# Copy to .env and adjust.\nPORT=3000\nLOG_LEVEL=info\n' },
    { path: 'README.md', contents: readme(options) },
    { path: 'src/env.ts', contents: ENV_MODULE },
    { path: 'src/app.ts', contents: appModule(options) },
    { path: 'src/index.ts', contents: ENTRY },
    { path: 'src/routes/index.get.ts', contents: ROOT_ROUTE },
  ]

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

export const TEMPLATES: Record<TemplateName, string> = {
  minimal: 'One route, nothing else',
  api: 'A small REST API with validation, uploads-ready schemas and OpenAPI',
}
