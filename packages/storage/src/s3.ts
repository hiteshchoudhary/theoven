import type {
  ListOptions,
  ListResult,
  PresignOptions,
  PutOptions,
  StorageDriver,
  StoredObject,
  Uploadable,
} from './types'
import { assertSafeKey, StorageError } from './types'

export interface S3Options {
  /** The bucket name. */
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  region?: string
  /**
   * For anything that is not AWS: R2, MinIO, Spaces, Backblaze.
   *
   * `https://<account>.r2.cloudflarestorage.com` for R2, `http://localhost:9000` for a local
   * MinIO. AWS needs no endpoint.
   */
  endpoint?: string
  /**
   * Put the bucket in the path rather than the hostname.
   *
   * MinIO and most self-hosted gateways need this; AWS and R2 do not.
   */
  virtualHostedStyle?: boolean
  /**
   * Bytes per part in a multipart upload. Bun's default is 5 MiB, the S3 minimum.
   *
   * Anything larger than this is uploaded in parts automatically — there is no separate
   * "multipart" API to call, and no size at which uploads start failing. Raising it trades
   * memory for fewer requests on a fast link.
   */
  partSize?: number
  /** Parts uploaded in parallel. Bun's default is 5. */
  queueSize?: number
  /** Retries per part before the upload fails. Bun's default is 3. */
  retry?: number
}

/**
 * S3-compatible object storage, on Bun's built-in client.
 *
 * Works against AWS, Cloudflare R2, MinIO, DigitalOcean Spaces and Backblaze B2 — the difference
 * between them is `endpoint`, not code.
 *
 * ```ts
 * app.use(storage(s3Storage({
 *   bucket: env.string('S3_BUCKET'),
 *   accessKeyId: env.string('S3_ACCESS_KEY_ID'),
 *   secretAccessKey: env.string('S3_SECRET_ACCESS_KEY'),
 * })))
 * ```
 *
 * No SDK. `Bun.S3Client` is in the runtime, signs its own requests, and streams — which is the
 * whole reason the storage brick is a hundred lines rather than a dependency tree.
 */
export function s3Storage(options: S3Options): StorageDriver {
  const { bucket } = options

  if (!bucket) {
    throw new StorageError(
      "s3Storage needs a bucket: s3Storage({ bucket: env.string('S3_BUCKET'), ... })",
      { driver: 's3' },
    )
  }

  // Credentials fall back to the standard AWS environment variables, which is what a deployment
  // with an instance role or a secrets mount already sets.
  const client = new Bun.S3Client({
    bucket,
    ...(options.accessKeyId ? { accessKeyId: options.accessKeyId } : {}),
    ...(options.secretAccessKey ? { secretAccessKey: options.secretAccessKey } : {}),
    ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    ...(options.region ? { region: options.region } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.virtualHostedStyle !== undefined
      ? { virtualHostedStyle: options.virtualHostedStyle }
      : {}),
    ...(options.partSize !== undefined ? { partSize: options.partSize } : {}),
    ...(options.queueSize !== undefined ? { queueSize: options.queueSize } : {}),
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
  })

  return {
    name: 's3',
    bucket,
    raw: client,

    put: async (key, body, putOptions) => {
      assertSafeKey(key)
      const type = putOptions.type ?? typeOf(body)

      try {
        // Handed to Bun whole. A `File` from a multipart upload streams from Bun's temporary
        // spill file straight to S3 — reading it into an ArrayBuffer first would put a
        // multi-gigabyte upload in memory for no reason.
        const size = await client.write(key, body as Parameters<typeof client.write>[0], {
          ...(type ? { type } : {}),
          ...(putOptions.acl ? { acl: putOptions.acl as never } : {}),
        })

        return {
          key,
          bucket,
          size: typeof size === 'number' ? size : sizeOf(body),
          type: type ?? 'application/octet-stream',
          lastModified: new Date(),
        }
      } catch (cause) {
        throw new StorageError(`Could not write "${key}" to ${bucket}.`, {
          driver: 's3',
          key,
          cause,
        })
      }
    },

    read: (key) => {
      assertSafeKey(key)
      return client.file(key)
    },

    remove: async (key) => {
      assertSafeKey(key)
      // Deleting something already absent is not an error: the caller wanted it gone, and it is.
      await client.delete(key).catch((cause: unknown) => {
        throw new StorageError(`Could not delete "${key}" from ${bucket}.`, {
          driver: 's3',
          key,
          cause,
        })
      })
    },

    exists: async (key) => {
      assertSafeKey(key)
      return client.exists(key)
    },

    stat: async (key) => {
      assertSafeKey(key)
      try {
        const info = await client.stat(key)
        return {
          key,
          bucket,
          size: info.size,
          type: info.type ?? 'application/octet-stream',
          lastModified: info.lastModified ? new Date(info.lastModified) : undefined,
        }
      } catch {
        // A missing object is a `null`, not a throw. Callers ask "is it there and how big" and
        // should not have to wrap that in a try.
        return null
      }
    },

    list: async (listOptions: ListOptions): Promise<ListResult> => {
      const response = await client.list({
        ...(listOptions.prefix ? { prefix: listOptions.prefix } : {}),
        ...(listOptions.limit ? { maxKeys: listOptions.limit } : {}),
        ...(listOptions.after ? { startAfter: listOptions.after } : {}),
      })

      const objects = (response.contents ?? []).map((entry) => ({
        key: entry.key,
        bucket,
        size: entry.size ?? 0,
        type: 'application/octet-stream',
        lastModified: entry.lastModified ? new Date(entry.lastModified) : undefined,
      }))

      return {
        objects,
        ...(response.isTruncated && objects.length > 0
          ? { next: objects[objects.length - 1]?.key }
          : {}),
      }
    },

    presign: (key, presignOptions) => {
      assertSafeKey(key)
      return client.presign(key, {
        expiresIn: presignOptions.expiresIn ?? 900,
        method: presignOptions.method ?? 'GET',
        ...(presignOptions.type ? { type: presignOptions.type } : {}),
      })
    },
  }
}

/** The content type a body already knows about, if any. */
function typeOf(body: Uploadable): string | undefined {
  if (body instanceof Blob && body.type) return body.type
  if (typeof body === 'string') return 'text/plain'
  return undefined
}

/** A size for bodies whose length is knowable without consuming them. */
function sizeOf(body: Uploadable): number {
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (typeof body === 'string') return Buffer.byteLength(body)
  // A stream's length is not knowable without draining it, and draining it to report a number
  // would defeat streaming.
  return 0
}
