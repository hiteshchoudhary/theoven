import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { route } from '../../route'
import { notes } from '../../schema'

/**
 * Public. Anyone can read notes; only a signed-in user can write one.
 *
 * `ctx.db` is the Drizzle client, so this is an ordinary Drizzle query — there is no Oven query
 * API in the way.
 */
export default route(
  {
    summary: 'List notes',
    tags: ['notes'],
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
  },
  (ctx) => ctx.db.select().from(notes).orderBy(desc(notes.createdAt)).limit(ctx.query.limit),
)
