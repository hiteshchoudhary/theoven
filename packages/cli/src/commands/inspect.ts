import { writeFile } from 'node:fs/promises'
import { generateOpenApi } from '@theoven/core'
import type { ParsedArgs } from '../args'
import { stringFlag } from '../args'
import { loadApp } from '../load'
import { CANDIDATES, resolveAppModule, resolveRoot } from '../paths'
import { BANNER, fail, info, routeTable, style, success } from '../ui'

/**
 * Commands that read the app without running it.
 *
 * Both import the *app module* rather than the entry, so asking for a route table does not bind
 * a port. See `paths.ts` for why the scaffold separates the two.
 */

function missingApp(): void {
  fail(
    'No app module found.',
    `Looked for ${CANDIDATES.app.join(', ')}. It should export the configured app without ` +
      'calling listen(). Pass one with --app <path>.',
  )
}

/** `oven routes` — prints the route table. */
export async function routes(args: ParsedArgs): Promise<number> {
  const root = resolveRoot()
  const file = resolveAppModule(root, stringFlag(args.flags, 'app'))

  if (!file) {
    missingApp()
    return 1
  }

  const app = await loadApp(file)
  if (!app) return 1

  const table = app.routes()
  info(`${BANNER} ${style.dim('routes')}`)
  info('')
  info(routeTable(table))
  info('')
  info(style.dim(`  ${table.length} route(s)`))

  await app.close({ timeout: 0 })
  return 0
}

/**
 * `oven openapi` — emits the OpenAPI document.
 *
 * Printed to stdout by default so it can be piped into a client generator; `--out` writes a
 * file instead. Nothing else is printed to stdout in that mode, or the pipe would receive a
 * banner along with the JSON.
 */
export async function openapiCommand(args: ParsedArgs): Promise<number> {
  const root = resolveRoot()
  const file = resolveAppModule(root, stringFlag(args.flags, 'app'))

  if (!file) {
    missingApp()
    return 1
  }

  const app = await loadApp(file)
  if (!app) return 1

  const document = generateOpenApi(app.routeTable() as Parameters<typeof generateOpenApi>[0], {
    info: {
      title: stringFlag(args.flags, 'title', 'API') ?? 'API',
      version: stringFlag(args.flags, 'api-version', '0.0.0') ?? '0.0.0',
    },
    // The spec and UI endpoints describe the document; including them in it is noise in
    // every generated client.
    exclude: ['/openapi.json', '/docs'],
  })

  const json = JSON.stringify(document, null, 2)
  const out = stringFlag(args.flags, 'out')

  if (out) {
    await writeFile(out, `${json}\n`)
    success(`wrote ${out}`)
  } else {
    // stdout only — this is the piping path.
    process.stdout.write(`${json}\n`)
  }

  await app.close({ timeout: 0 })
  return 0
}
