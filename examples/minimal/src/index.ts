/**
 * The smallest useful Oven app.
 *
 * Routes come from the filesystem; schemas come from each route file; the OpenAPI document and
 * its UI come from those schemas. Nothing here wires any of that together.
 *
 *   bun run --cwd examples/minimal dev
 */
import { createApp, loadRoutes, openapi, requestLogger, securityHeaders } from '@theoven/core'

const app = createApp({ logLevel: 'debug' })
  .use(requestLogger())
  .use(securityHeaders())
  .use(openapi({ info: { title: 'Oven example API', version: '0.1.0' } }))

await loadRoutes(app, `${import.meta.dir}/routes`)
await app.listen()

app.logger.info(`Oven listening on ${app.url}`)
app.logger.info(`API reference at ${app.url}docs`)
for (const { method, pattern } of app.routes()) {
  app.logger.info(`  ${method.padEnd(6)} ${pattern}`)
}
