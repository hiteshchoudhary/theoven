import { Elysia } from 'elysia'

new Elysia()
  .get('/', () => 'ok')
  .get('/users/:id', ({ params }) => ({ id: params.id }))
  .listen(Number(Bun.env.PORT))
