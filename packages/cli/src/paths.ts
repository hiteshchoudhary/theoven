import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Locating the app inside a project.
 *
 * Two different things get resolved, and conflating them is a trap worth avoiding:
 *
 *   - The **entry**, which starts a server. `oven dev` and `oven start` run this.
 *   - The **app module**, which exports the configured app *without* listening. `oven routes`
 *     and `oven openapi` import this.
 *
 * If inspection commands imported the entry, asking for a route table would bind a port. The
 * scaffold therefore splits `src/app.ts` (builds and exports) from `src/index.ts` (listens),
 * and these helpers look for that shape.
 */

const ENTRY_CANDIDATES = ['src/index.ts', 'src/main.ts', 'index.ts', 'main.ts']
const APP_CANDIDATES = ['src/app.ts', 'app.ts', 'src/server.ts']
const ROUTES_CANDIDATES = ['src/routes', 'routes']

function firstExisting(root: string, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const full = join(root, candidate)
    if (existsSync(full)) return full
  }
  return undefined
}

export function resolveRoot(cwd = process.cwd()): string {
  return resolve(cwd)
}

/** Locates the module that starts the server. */
export function resolveEntry(root: string, override?: string): string | undefined {
  if (override) return isAbsolute(override) ? override : join(root, override)
  return firstExisting(root, ENTRY_CANDIDATES)
}

/** Locates the module that exports a configured app without listening. */
export function resolveAppModule(root: string, override?: string): string | undefined {
  if (override) return isAbsolute(override) ? override : join(root, override)
  return firstExisting(root, APP_CANDIDATES)
}

/** Locates the file-based routes directory. */
export function resolveRoutesDir(root: string, override?: string): string | undefined {
  if (override) return isAbsolute(override) ? override : join(root, override)
  return firstExisting(root, ROUTES_CANDIDATES)
}

export const CANDIDATES = {
  entry: ENTRY_CANDIDATES,
  app: APP_CANDIDATES,
  routes: ROUTES_CANDIDATES,
} as const
