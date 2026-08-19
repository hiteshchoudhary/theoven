import app from './app'

/**
 * The entry point, separate from `app.ts` so `oven routes`, `oven openapi` and `oven worker`
 * can import the app without binding a port.
 */
await app.listen(Number(process.env.PORT ?? 3000))

app.logger.info(`listening on ${app.url}`)
app.logger.info(`api reference at ${app.url}docs`)
app.logger.info(`mail inbox at ${app.url}_oven/mail`)
app.logger.info(`queue dashboard at ${app.url}_oven/queue`)
