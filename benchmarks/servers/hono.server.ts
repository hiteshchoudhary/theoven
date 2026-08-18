import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.text('ok'))
app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }))

Bun.serve({ port: Number(Bun.env.PORT), fetch: app.fetch })
