import app from './app'

await app.listen()

app.logger.info(`Oven listening on ${app.url}`)
app.logger.info(`API reference at ${app.url}docs`)
for (const { method, pattern } of app.routes()) {
  app.logger.info(`  ${method.padEnd(6)} ${pattern}`)
}
