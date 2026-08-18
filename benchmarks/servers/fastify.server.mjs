import Fastify from 'fastify'

const app = Fastify({ logger: false })
app.get('/', (_req, reply) => reply.type('text/plain').send('ok'))
app.get('/users/:id', (req) => ({ id: req.params.id }))
await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' })
