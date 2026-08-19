import { mkdir, readdir, rm, stat as statFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type {
  ListOptions,
  ListResult,
  PutOptions,
  StorageDriver,
  StoredObject,
  Uploadable,
} from './types'
import { assertSafeKey, StorageError } from './types'

export interface DiskOptions {
  /** Directory objects are written under. Created on first write. */
  dir: string
  /**
   * Name reported as the bucket. Default `local`.
   *
   * Cosmetic, but it means an app that logs `object.bucket` reads the same in development as it
   * does in production.
   */
  bucket?: string
}

/**
 * Object storage on the local filesystem.
 *
 * Exists so an application runs with **no S3 at all**: `oven create`, `bun run dev`, upload a
 * file, and it lands in `./storage`. Configuring a real bucket is then changing one driver, not
 * discovering that uploads were never wired.
 *
 * Content types are the one thing a directory cannot store, so they are inferred from the key's
 * extension on the way back out. That is a real difference from S3 and is on the brick's page.
 */
export function diskStorage(options: DiskOptions): StorageDriver {
  const root = resolve(options.dir)
  const bucket = options.bucket ?? 'local'

  /**
   * Resolves a key inside the root, and refuses anything that escapes it.
   *
   * `assertSafeKey` has already rejected the obvious traversals; this is the check that holds
   * when a symlink or an unusual encoding gets past the first one. Two checks, because the
   * consequence here is writing outside the directory the operator chose.
   */
  function pathFor(key: string): string {
    assertSafeKey(key)
    const full = resolve(root, key)
    if (full !== root && !full.startsWith(root + sep)) {
      throw new StorageError(`"${key}" resolves outside the storage directory.`, {
        driver: 'disk',
        key,
      })
    }
    return full
  }

  return {
    name: 'disk',
    bucket,
    raw: root,

    put: async (key, body, putOptions) => {
      const path = pathFor(key)
      await mkdir(dirname(path), { recursive: true })

      try {
        // Bun.write streams a Blob or a ReadableStream rather than buffering it, so a large
        // multipart upload goes spill-file to destination without passing through memory.
        await Bun.write(path, body as Parameters<typeof Bun.write>[1])
      } catch (cause) {
        throw new StorageError(`Could not write "${key}" to ${root}.`, {
          driver: 'disk',
          key,
          cause,
        })
      }

      const written = await statFile(path)
      return {
        key,
        bucket,
        size: written.size,
        type: putOptions.type ?? typeOf(body) ?? contentTypeFor(key),
        lastModified: written.mtime,
      }
    },

    read: (key) => Bun.file(pathFor(key), { type: contentTypeFor(key) }),

    remove: async (key) => {
      // `force` so deleting something already absent succeeds: the caller wanted it gone.
      await rm(pathFor(key), { force: true })
    },

    exists: (key) => Bun.file(pathFor(key)).exists(),

    stat: async (key) => {
      try {
        const info = await statFile(pathFor(key))
        if (!info.isFile()) return null
        return {
          key,
          bucket,
          size: info.size,
          type: contentTypeFor(key),
          lastModified: info.mtime,
        }
      } catch {
        return null
      }
    },

    list: async (listOptions: ListOptions): Promise<ListResult> => {
      const prefix = listOptions.prefix ?? ''
      const limit = listOptions.limit ?? 1000

      let keys: string[]
      try {
        keys = (await readdir(root, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          // `parentPath` is absolute; keys are relative and always use forward slashes, so a
          // listing reads the same on Windows as it does anywhere else.
          .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
          .filter((key) => key.startsWith(prefix))
          .sort()
      } catch {
        // Nothing has been written yet. An empty bucket, not an error.
        return { objects: [] }
      }

      const after = listOptions.after
      const remaining = after ? keys.filter((key) => key > after) : keys
      const page = remaining.slice(0, limit)

      const objects: StoredObject[] = await Promise.all(
        page.map(async (key) => {
          const info = await statFile(join(root, key))
          return {
            key,
            bucket,
            size: info.size,
            type: contentTypeFor(key),
            lastModified: info.mtime,
          }
        }),
      )

      return {
        objects,
        ...(remaining.length > page.length ? { next: page[page.length - 1] } : {}),
      }
    },

    /**
     * No `presign`.
     *
     * A local directory cannot hand a browser a URL that uploads straight into it — there is no
     * signing authority and no endpoint. The capability is declared absent so `oven doctor` and
     * the brick can say so at boot, rather than a `presignUpload` call failing in production on
     * the day someone switched drivers.
     */
  }
}

function typeOf(body: Uploadable): string | undefined {
  if (body instanceof Blob && body.type) return body.type
  return undefined
}

/**
 * Content type from the key's extension.
 *
 * `Bun.file()` already does this for a path, so this exists for `stat` and `list`, which report
 * a type without opening anything.
 */
function contentTypeFor(key: string): string {
  return Bun.file(key).type || 'application/octet-stream'
}
