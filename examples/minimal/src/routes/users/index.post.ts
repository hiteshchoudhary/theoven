import { defineRoute } from '@theoven/core'
import { z } from 'zod'
import { users } from './_store'

export default defineRoute(
  {
    summary: 'Create a user',
    tags: ['users'],
    body: z.object({ name: z.string().min(1) }),
    response: { 201: z.object({ id: z.string(), name: z.string() }) },
  },
  (ctx) => {
    const id = String(users.size + 1)
    const user = { id, name: ctx.body.name }
    users.set(id, user)
    ctx.status = 201
    ctx.set('location', `/users/${id}`)
    return user
  },
)
