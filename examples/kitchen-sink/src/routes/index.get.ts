export const summary = 'What this app has'

export default (ctx: {
  db: unknown
  storage: { driver: string }
  queue: { driver: string }
  mail: { driver: string }
}) => ({
  name: 'kitchen-sink',
  bricks: {
    storage: ctx.storage.driver,
    queue: ctx.queue.driver,
    mail: ctx.mail.driver,
  },
})
