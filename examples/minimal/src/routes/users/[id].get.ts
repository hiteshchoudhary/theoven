import { defineRoute, NotFound } from '@theoven/core'
import { z } from 'zod'
import { users } from './_store'

export default defineRoute(
  {
    summary: 'Fetch one user',
    tags: ['users'],
    params: z.object({ id: z.string() }),
    response: { 200: z.object({ id: z.string(), name: z.string() }) },
  },
  (ctx) => {
    const user = users.get(ctx.params.id)
    if (!user) throw new NotFound(`No user with id ${ctx.params.id}`)
    return user
  },
)
