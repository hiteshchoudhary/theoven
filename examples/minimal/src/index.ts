/**
 * The smallest useful Oven app.
 *
 * Routes are registered programmatically here. File-based routing (§1.8) is the DX users will
 * actually see; it compiles down to exactly these calls.
 *
 *   bun run --cwd examples/minimal dev
 */
import { createApp, NotFound } from '@theoven/core'

const users = new Map([
  ['1', { id: '1', name: 'Ada Lovelace' }],
  ['2', { id: '2', name: 'Grace Hopper' }],
])

const app = createApp({ logLevel: 'debug' })

app.get('/', () => ({ framework: 'oven', status: 'warm' }))

app.get('/users', () => [...users.values()])

app.get('/users/:id', (ctx) => {
  const user = users.get(ctx.params.id as string)
  // Throwing is the whole error path — no next(err), no try/catch in the handler.
  if (!user) throw new NotFound(`No user with id ${ctx.params.id}`)
  return user
})

app.post('/users', async (ctx) => {
  const body = (await ctx.req.json()) as { name: string }
  const id = String(users.size + 1)
  users.set(id, { id, name: body.name })
  ctx.status = 201
  ctx.set('location', `/users/${id}`)
  return users.get(id)
})

app.delete('/users/:id', (ctx) => {
  users.delete(ctx.params.id as string)
  return null // -> 204
})

app.get('/slow', async () => {
  await Bun.sleep(2_000)
  return { note: 'Ctrl-C during this request: shutdown waits for it to finish.' }
})

app.listen()

app.logger.info(`Oven listening on ${app.url}`)
for (const { method, pattern } of app.routes()) {
  app.logger.info(`  ${method.padEnd(6)} ${pattern}`)
}
