import { defineRoute } from '@theoven/core'
import { z } from 'zod'
import { users } from './_store'

export default defineRoute(
  {
    summary: 'List users',
    tags: ['users'],
    query: z.object({ limit: z.coerce.number().min(1).max(100).default(20) }),
    response: { 200: z.array(z.object({ id: z.string(), name: z.string() })) },
  },
  // `ctx.query.limit` is a number here, inferred from the schema above.
  (ctx) => [...users.values()].slice(0, ctx.query.limit),
)
