/**
 * The smallest useful Oven app.
 *
 * Routes come from the filesystem; schemas come from each route file; the OpenAPI document and
 * its UI come from those schemas. Nothing here wires any of that together.
 *
 *   bun run --cwd examples/minimal dev
 *
 * Split from `index.ts` so `oven routes`, `oven openapi` and the test below can import the app
 * without binding a port.
 */
import { createApp, loadRoutes, openapi, requestLogger, securityHeaders } from '@theoven/core'

export const app = createApp({ logLevel: 'debug' })
  .use(requestLogger())
  .use(securityHeaders())
  .use(openapi({ info: { title: 'Oven example API', version: '0.1.0' } }))

await loadRoutes(app, `${import.meta.dir}/routes`)
export default app
