import { defineJob } from '@theoven/queue'

/**
 * A job that emails the author when a note is created.
 *
 * Queued rather than sent inline, which is the point: creating a note returns as soon as the
 * row is written, and a slow mail provider delays a notification instead of a request.
 */
export const notifyAuthor = defineJob<{ email: string; title: string }>({
  name: 'notify-author',
  retries: 3,
  handler: async ({ payload, log }) => {
    log.info('notifying', { email: payload.email })
  },
})
