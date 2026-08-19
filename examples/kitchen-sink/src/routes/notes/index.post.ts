import { z } from 'zod'
import { notifyAuthor } from '../../jobs'
import { route } from '../../route'
import { notes } from '../../schema'

/**
 * Writes a note, optionally with a file, and queues a notification.
 *
 * Five bricks in nine lines, and none of them are wired here: the guard comes from `auth: true`,
 * the upload arrives parsed because file handling is always on, storage and the queue are on the
 * context because they were registered.
 */
export default route(
  {
    summary: 'Create a note',
    tags: ['notes'],
    auth: true,
    body: z.object({
      title: z.string().min(1).max(200),
      body: z.string().max(10_000).optional(),
      file: z.file().max(5_000_000).optional(),
    }),
  },
  async (ctx) => {
    // `ctx.user` is non-null in here because the route declares `auth: true`.
    const id = crypto.randomUUID()

    const attachment = ctx.body.file
      ? (await ctx.storage.upload(`notes/${id}/${ctx.body.file.name}`, ctx.body.file)).key
      : null

    const [note] = await ctx.db
      .insert(notes)
      .values({
        id,
        authorId: ctx.user.id,
        title: ctx.body.title,
        body: ctx.body.body ?? null,
        attachment,
        createdAt: new Date(),
      })
      .returning()

    await ctx.queue.dispatch(notifyAuthor, {
      email: ctx.user.email ?? '',
      title: ctx.body.title,
    })

    ctx.status = 201
    return note
  },
)
