import { createApp, silentLogger } from '../../packages/core/src/index'

const app = createApp({ logger: silentLogger })
app.get('/', () => 'ok')
app.get('/users/:id', (ctx) => ({ id: ctx.params.id }))
app.listen(Number(Bun.env.PORT))
