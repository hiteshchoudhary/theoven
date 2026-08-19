import { NotFound } from '@theoven/core'
import { route } from '../../route'

/**
 * Serves an uploaded file.
 *
 * `download()` returns a lazy Blob, so returning it streams the object to the client without the
 * body passing through memory. Guarded, because the storage brick refuses traversing keys — not
 * unauthorised ones.
 */
export default route({ summary: 'Download an attachment', auth: true }, async (ctx) => {
  // `[...key]` becomes `*key` in the pattern, so the segment arrives as `ctx.params.key`.
  const key = String(ctx.params.key ?? '')
  if (!(await ctx.storage.exists(key))) throw new NotFound(`No file at ${key}.`)
  return ctx.storage.download(key)
})
