import {
  assertSafeKey,
  type ListOptions,
  type ListResult,
  type PresignOptions,
  type PutOptions,
  type StorageDriver,
  StorageError,
  type StoredObject,
  type Uploadable,
} from '@theoven/storage'

export interface BunnyOptions {
  /** Storage zone name — the bucket. */
  zone: string
  /** Storage zone password, from the Bunny dashboard. Not the account API key. */
  accessKey: string
  /**
   * Storage region host. Default `storage.bunnycdn.com` (Falkenstein).
   *
   * Others are prefixed: `ny.storage.bunnycdn.com`, `la.`, `sg.`, `syd.`, `uk.`, `se.`, `br.`,
   * `jh.`. A zone created in one region is not reachable through another's host.
   */
  region?: string
  /**
   * Pull-zone hostname used to build public URLs, e.g. `cdn.example.com` or
   * `my-zone.b-cdn.net`.
   *
   * Without it `read()` still works — it fetches through the storage API — but downloads come
   * from the storage origin rather than the CDN edge, which is slower and costs more.
   */
  pullZone?: string
  /** Token authentication key for the pull zone, if signed URLs are enabled on it. */
  tokenKey?: string
  /** Injected in tests. Defaults to global `fetch`. */
  fetcher?: typeof fetch
}

interface BunnyListEntry {
  ObjectName: string
  Length: number
  LastChanged: string
  IsDirectory: boolean
  ContentType?: string
}

/**
 * Bunny.net Storage, through the same contract as S3.
 *
 * Everything on [`ctx.storage`](/docs/bricks/storage/) works unchanged — upload, download,
 * list, delete. What Bunny adds is cheap egress through its pull zones, which is the reason to
 * pick it.
 *
 * ```ts
 * app.use(storage(bunnyStorage({
 *   zone: env.string('BUNNY_ZONE'),
 *   accessKey: env.string('BUNNY_ACCESS_KEY'),
 *   pullZone: 'cdn.example.com',
 * })))
 * ```
 */
export function bunnyStorage(options: BunnyOptions): StorageDriver {
  const { zone, accessKey } = options

  if (!zone) throw new StorageError('bunnyStorage needs a storage zone.', { driver: 'bunny' })
  if (!accessKey) {
    throw new StorageError(
      'bunnyStorage needs the storage zone password. It is not the account API key — find it ' +
        'under the zone’s FTP & API Access.',
      { driver: 'bunny' },
    )
  }

  const region = options.region ?? 'storage.bunnycdn.com'
  const fetcher = options.fetcher ?? fetch
  const base = `https://${region}/${zone}`

  const url = (key: string) => `${base}/${encodeKey(key)}`
  const headers = { AccessKey: accessKey }

  async function call(method: string, target: string, body?: Uint8Array): Promise<Response> {
    const response = await fetcher(target, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    })

    // 404 is a legitimate answer for the callers below; anything else is a failure.
    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => '')
      throw new StorageError(
        `Bunny answered ${response.status} for ${method} ${target}. ${detail}`.trim(),
        { driver: 'bunny' },
      )
    }
    return response
  }

  return {
    name: 'bunny',
    bucket: zone,
    raw: { base, pullZone: options.pullZone },

    put: async (key, body, putOptions) => {
      assertSafeKey(key)

      const payload = await toBody(body)
      await call('PUT', url(key), payload)

      return {
        key,
        bucket: zone,
        size: payload.byteLength,
        type: putOptions.type ?? typeOf(body) ?? 'application/octet-stream',
        lastModified: new Date(),
      }
    },

    /**
     * A lazy handle, like every other driver.
     *
     * Reads go through the pull zone when one is configured — that is the edge, and the whole
     * point of Bunny. Without one it falls back to the storage API, which works and is slower.
     */
    read: (key) => {
      assertSafeKey(key)
      const target = options.pullZone ? `https://${options.pullZone}/${encodeKey(key)}` : url(key)

      return lazyBlob(async () => {
        const response = await fetcher(target, options.pullZone ? {} : { headers })
        if (!response.ok) {
          throw new StorageError(`Bunny answered ${response.status} reading "${key}".`, {
            driver: 'bunny',
            key,
          })
        }
        return response
      })
    },

    remove: async (key) => {
      assertSafeKey(key)
      // A 404 means the caller wanted it gone and it is.
      await call('DELETE', url(key))
    },

    exists: async (key) => {
      assertSafeKey(key)
      return (await call('HEAD', url(key))).ok
    },

    stat: async (key) => {
      assertSafeKey(key)
      const response = await call('HEAD', url(key))
      if (!response.ok) return null

      const length = response.headers.get('content-length')
      const modified = response.headers.get('last-modified')

      return {
        key,
        bucket: zone,
        size: length ? Number(length) : 0,
        type: response.headers.get('content-type') ?? 'application/octet-stream',
        lastModified: modified ? new Date(modified) : undefined,
      }
    },

    list: async (listOptions: ListOptions): Promise<ListResult> => {
      const prefix = listOptions.prefix ?? ''
      // Bunny lists a directory, so the prefix is split into "directory" and "starts with".
      const slash = prefix.lastIndexOf('/')
      const directory = slash === -1 ? '' : prefix.slice(0, slash + 1)
      const startsWith = slash === -1 ? prefix : prefix.slice(slash + 1)

      const response = await call('GET', `${base}/${directory}`)
      if (!response.ok) return { objects: [] }

      const entries = (await response.json()) as BunnyListEntry[]
      const limit = listOptions.limit ?? 1000

      let objects: StoredObject[] = entries
        .filter((entry) => !entry.IsDirectory && entry.ObjectName.startsWith(startsWith))
        .map((entry) => ({
          key: `${directory}${entry.ObjectName}`,
          bucket: zone,
          size: entry.Length,
          type: entry.ContentType || 'application/octet-stream',
          lastModified: entry.LastChanged ? new Date(entry.LastChanged) : undefined,
        }))
        .sort((a, b) => a.key.localeCompare(b.key))

      if (listOptions.after) {
        const after = listOptions.after
        objects = objects.filter((object) => object.key > after)
      }

      const page = objects.slice(0, limit)
      return {
        objects: page,
        ...(objects.length > page.length ? { next: page[page.length - 1]?.key } : {}),
      }
    },

    /**
     * Signs a pull-zone URL with Bunny's token authentication.
     *
     * `GET` only. Bunny's token auth protects *delivery*; there is no signed-upload equivalent,
     * so `presignUpload` is not available — see the brick page.
     */
    presign:
      options.pullZone && options.tokenKey
        ? (key, presignOptions: PresignOptions) => {
            assertSafeKey(key)

            if ((presignOptions.method ?? 'GET') !== 'GET') {
              throw new StorageError(
                'Bunny token authentication signs downloads only. Upload through your server, or ' +
                  'use an S3-compatible driver for presigned uploads.',
                { driver: 'bunny', key },
              )
            }

            const path = `/${encodeKey(key)}`
            const expires = Math.floor(Date.now() / 1000) + (presignOptions.expiresIn ?? 900)

            // Bunny's scheme: base64 of md5(tokenKey + path + expires), made URL-safe.
            const digest = new Bun.CryptoHasher('md5')
              .update(`${options.tokenKey}${path}${expires}`)
              .digest('base64')
              .replace(/\n/g, '')
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=/g, '')

            return `https://${options.pullZone}${path}?token=${digest}&expires=${expires}`
          }
        : undefined,
  }
}

/** Percent-encodes each segment, leaving the separators alone. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

async function toBody(body: Uploadable): Promise<Uint8Array> {
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)

  // A stream has to be collected: Bunny's PUT needs a known length.
  const chunks: Uint8Array[] = []
  for await (const chunk of body as ReadableStream<Uint8Array>) chunks.push(chunk)

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function typeOf(body: Uploadable): string | undefined {
  if (body instanceof Blob && body.type) return body.type
  if (typeof body === 'string') return 'text/plain'
  return undefined
}

/**
 * A `Blob` that fetches on first read.
 *
 * The contract promises a lazy handle — returning bytes eagerly would make
 * `return ctx.storage.download(key)` download the whole object into this process before
 * streaming a copy to the client.
 */
function lazyBlob(open: () => Promise<Response>): Blob {
  const blob = new Blob([])

  return Object.create(blob, {
    stream: { value: () => streamFrom(open()) },
    arrayBuffer: { value: async () => (await open()).arrayBuffer() },
    text: { value: async () => (await open()).text() },
    bytes: { value: async () => new Uint8Array(await (await open()).arrayBuffer()) },
  }) as Blob
}

function streamFrom(response: Promise<Response>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const body = (await response).body
      if (!body) {
        controller.close()
        return
      }
      for await (const chunk of body) controller.enqueue(chunk as Uint8Array)
      controller.close()
    },
  })
}
