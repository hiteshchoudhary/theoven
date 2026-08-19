import { NotFound } from '@theoven/core'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { route } from '../../route'
import { notes } from '../../schema'

export default route(
  { summary: 'One note', tags: ['notes'], params: z.object({ id: z.uuid() }) },
  async (ctx) => {
    const [note] = await ctx.db.select().from(notes).where(eq(notes.id, ctx.params.id))
    // Thrown, not returned. The error handler turns it into problem+json.
    if (!note) throw new NotFound(`No note with id ${ctx.params.id}.`)
    return note
  },
)
