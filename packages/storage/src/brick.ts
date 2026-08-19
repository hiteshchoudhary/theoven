import type { Brick } from '@theoven/core'
import { createService, type StorageService } from './service'
import type { StorageDriver } from './types'
import { StorageError } from './types'

export interface StorageOptions {
  /**
   * Extra buckets, reached with `ctx.storage.bucket('avatars')`.
   *
   * ```ts
   * storage(s3Storage({ bucket: 'uploads' }), {
   *   buckets: { avatars: s3Storage({ bucket: 'avatars' }) },
   * })
   * ```
   */
  buckets?: Record<string, StorageDriver>
  /**
   * Allow the local-disk driver outside development.
   *
   * Refused by default: an app storing uploads on a container's filesystem loses every one of
   * them on the next deploy, and looks perfectly healthy while doing it. The failure surfaces
   * weeks later as missing avatars nobody can explain.
   */
  allowDiskInProduction?: boolean
}

/**
 * The storage brick.
 *
 * ```ts
 * app.use(storage(env.has('S3_BUCKET')
 *   ? s3Storage({ bucket: env.string('S3_BUCKET') })
 *   : diskStorage({ dir: './storage' })))
 *
 * app.post('/avatar', async (ctx) => {
 *   const { file } = await ctx.body
 *   return ctx.storage.upload(`avatars/${ctx.user.id}`, file)
 * })
 * ```
 *
 * Defaults to a local directory so `oven create` produces an app where uploads work
 * immediately. Moving to S3 is environment variables, not code.
 */
export function storage(
  driver: StorageDriver,
  options: StorageOptions = {},
): Brick<'storage', StorageService> {
  return {
    name: 'storage',

    setup: (context) => {
      // Built once, at boot, so `bucket()` is a map lookup rather than a construction per call.
      const buckets = new Map<string, StorageDriver>(Object.entries(options.buckets ?? {}))
      buckets.set(driver.bucket, driver)

      /**
       * One check, covering the default bucket and every named one.
       *
       * It was two — an explicit check on `driver` and then this loop — until deleting the
       * first one changed no test, because the driver is in the map. Two checks that cannot
       * disagree are one check and a place for them to drift apart later.
       */
      if (!context.development && !options.allowDiskInProduction) {
        for (const [name, candidate] of buckets) {
          if (candidate.name !== 'disk') continue

          const which = candidate === driver ? '' : ` (configured as "${name}")`
          throw new StorageError(
            `The local-disk storage driver${which} is refused in production: uploads written ` +
              "to a container's filesystem are lost on the next deploy, and the service looks " +
              'healthy while it happens. Configure an S3-compatible driver, or pass ' +
              'allowDiskInProduction if this host has real persistent storage.',
            { driver: 'disk' },
          )
        }
      }

      return createService(driver, buckets, new Map())
    },
  }
}
