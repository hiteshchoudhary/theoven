import type { Logger } from '@theoven/core'
import { fail } from './ui'

/**
 * Imports a module that is expected to export an Oven app.
 *
 * A default export or a named `app` export both work: both read naturally, and forcing one
 * would be an arbitrary rule the error message has to keep explaining.
 */
export interface LoadedApp {
  routes(): ReadonlyArray<{ method: string; pattern: string }>
  routeTable(): ReadonlyArray<{ method: string; pattern: string; schema: unknown }>
  ready(): Promise<void>
  close(options?: { timeout?: number }): Promise<void>
  /**
   * A brick's contributed service.
   *
   * Untyped here on purpose: the CLI loads an app it knows nothing about at compile time, so
   * the real typing lives on `App` and this is the runtime shape.
   */
  service(name: string): unknown
  logger: Logger
}

export function looksLikeApp(value: unknown): value is LoadedApp {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LoadedApp).routes === 'function' &&
    typeof (value as LoadedApp).routeTable === 'function'
  )
}

export async function loadApp(file: string): Promise<LoadedApp | null> {
  let module: Record<string, unknown>
  try {
    module = (await import(file)) as Record<string, unknown>
  } catch (thrown) {
    fail(`Could not import ${file}`, thrown instanceof Error ? thrown.message : String(thrown))
    return null
  }

  const candidate = module.default ?? module.app
  if (!looksLikeApp(candidate)) {
    fail(
      `${file} does not export an Oven app.`,
      'Export it as the default, or as a named `app` export. Keep listen() in a separate ' +
        'entry file so inspecting the app does not bind a port.',
    )
    return null
  }

  await candidate.ready()
  return candidate
}
