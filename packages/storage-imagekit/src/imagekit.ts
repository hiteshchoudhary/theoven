import {
  assertSafeKey,
  type ListOptions,
  type ListResult,
  type PutOptions,
  type StorageDriver,
  StorageError,
  type StoredObject,
  type Uploadable,
} from '@theoven/storage'
import { buildUrl, type Transformation, type UrlOptions } from './url'

export interface ImageKitOptions {
  /** Private API key, from the ImageKit dashboard. Never send this to a browser. */
  privateKey: string
  /** URL endpoint, e.g. `https://ik.imagekit.io/your_id`. */
  urlEndpoint: string
  /** Injected in tests. Defaults to global `fetch`. */
  fetcher?: typeof fetch
}

interface ImageKitFile {
  fileId: string
  name: string
  filePath: string
  size: number
  mime?: string
  updatedAt?: string
}

/** The driver, plus the URL builder that the storage contract has no place for. */
export interface ImageKitDriver extends StorageDriver {
  /**
   * A delivery URL, with optional transformations and signing.
   *
   * ```ts
   * const driver = imagekitStorage({ ... })
   * driver.url('avatars/1.png', { transform: { width: 200, format: 'auto' } })
   * ```
   */
  url(key: string, options?: UrlOptions): string
}

/**
 * ImageKit through the storage contract.
 *
 * `ctx.storage.upload()` and friends work as they do on S3 or Bunny, and `driver.url()` gives you
 * the transformations that are the reason to use ImageKit at all.
 */
export function imagekitStorage(options: ImageKitOptions): ImageKitDriver {
  const { privateKey, urlEndpoint } = options

  if (!privateKey) {
    throw new StorageError('imagekitStorage needs your private API key.', { driver: 'imagekit' })
  }
  if (!urlEndpoint) {
    throw new StorageError(
      'imagekitStorage needs your URL endpoint, e.g. https://ik.imagekit.io/your_id.',
      { driver: 'imagekit' },
    )
  }

  const fetcher = options.fetcher ?? fetch
  // ImageKit uses HTTP Basic with the private key as the username and an empty password.
  const auth = `Basic ${Buffer.from(`${privateKey}:`).toString('base64')}`

  async function api(method: string, path: string, body?: FormData): Promise<Response> {
    const response = await fetcher(`https://api.imagekit.io/v1${path}`, {
      method,
      headers: { authorization: auth },
      ...(body ? { body } : {}),
    })

    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => '')
      throw new StorageError(
        `ImageKit answered ${response.status} for ${method} ${path}. ${detail}`.trim(),
        { driver: 'imagekit' },
      )
    }
    return response
  }

  /**
   * Finds a file's id from its path.
   *
   * The contract is path-keyed; ImageKit deletes and inspects by `fileId`. So anything but an
   * upload costs an extra lookup — a real difference from S3, and on the brick's page rather
   * than hidden here.
   */
  async function fileFor(key: string): Promise<ImageKitFile | undefined> {
    const slash = key.lastIndexOf('/')
    const folder = slash === -1 ? '/' : `/${key.slice(0, slash)}`
    const name = slash === -1 ? key : key.slice(slash + 1)

    const response = await api(
      'GET',
      `/files?path=${encodeURIComponent(folder)}&searchQuery=${encodeURIComponent(`name="${name}"`)}`,
    )
    if (!response.ok) return undefined

    const files = (await response.json()) as ImageKitFile[]
    return files.find((file) => file.filePath.replace(/^\//, '') === key) ?? files[0]
  }

  const toObject = (file: ImageKitFile): StoredObject => ({
    key: file.filePath.replace(/^\//, ''),
    bucket: urlEndpoint,
    size: file.size,
    type: file.mime ?? 'application/octet-stream',
    lastModified: file.updatedAt ? new Date(file.updatedAt) : undefined,
  })

  return {
    name: 'imagekit',
    bucket: urlEndpoint,
    raw: { urlEndpoint },

    url: (key, urlOptions) => buildUrl(urlEndpoint, privateKey, key, urlOptions),

    put: async (key, body, putOptions: PutOptions) => {
      assertSafeKey(key)

      const slash = key.lastIndexOf('/')
      const folder = slash === -1 ? '/' : `/${key.slice(0, slash)}`
      const name = slash === -1 ? key : key.slice(slash + 1)

      const form = new FormData()
      form.set('file', await toBlob(body, putOptions.type), name)
      form.set('fileName', name)
      form.set('folder', folder)
      // Otherwise ImageKit appends a random suffix and the key you asked for is not the key you
      // get — which breaks every other method in this contract.
      form.set('useUniqueFileName', 'false')

      const response = await fetcher('https://upload.imagekit.io/api/v1/files/upload', {
        method: 'POST',
        headers: { authorization: auth },
        body: form,
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new StorageError(
          `ImageKit refused the upload (${response.status}). ${detail}`.trim(),
          {
            driver: 'imagekit',
            key,
          },
        )
      }

      return toObject((await response.json()) as ImageKitFile)
    },

    read: (key) => {
      assertSafeKey(key)
      const target = buildUrl(urlEndpoint, privateKey, key)

      return lazyBlob(async () => {
        const response = await fetcher(target)
        if (!response.ok) {
          throw new StorageError(`ImageKit answered ${response.status} reading "${key}".`, {
            driver: 'imagekit',
            key,
          })
        }
        return response
      })
    },

    remove: async (key) => {
      assertSafeKey(key)
      const file = await fileFor(key)
      // Already gone is the outcome the caller wanted.
      if (!file) return
      await api('DELETE', `/files/${file.fileId}`)
    },

    exists: async (key) => {
      assertSafeKey(key)
      return (await fileFor(key)) !== undefined
    },

    stat: async (key) => {
      assertSafeKey(key)
      const file = await fileFor(key)
      return file ? toObject(file) : null
    },

    list: async (listOptions: ListOptions): Promise<ListResult> => {
      const limit = listOptions.limit ?? 100
      const prefix = listOptions.prefix ?? ''
      const slash = prefix.lastIndexOf('/')
      const folder = slash === -1 ? '/' : `/${prefix.slice(0, slash)}`

      const response = await api(
        'GET',
        `/files?path=${encodeURIComponent(folder)}&limit=${limit}` +
          (listOptions.after ? `&skip=${encodeURIComponent(listOptions.after)}` : ''),
      )
      if (!response.ok) return { objects: [] }

      const files = (await response.json()) as ImageKitFile[]
      const objects = files.map(toObject).filter((object) => object.key.startsWith(prefix))

      return {
        objects,
        // ImageKit pages by offset, so `next` is a count rather than a key.
        ...(files.length === limit
          ? { next: String((Number(listOptions.after) || 0) + limit) }
          : {}),
      }
    },

    /**
     * No presigning.
     *
     * ImageKit signs *delivery* URLs — see `driver.url({ expiresIn })` — but browser uploads use
     * a different mechanism: a server-generated token/signature triple posted to their upload
     * endpoint, which does not fit `presignUpload`'s "here is a URL, PUT to it" shape. Saying so
     * beats handing back a URL that fails.
     */
  }
}

async function toBlob(body: Uploadable, type: string | undefined): Promise<Blob> {
  if (body instanceof Blob) return body
  if (typeof body === 'string') return new Blob([body], { type: type ?? 'text/plain' })
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return new Blob([body as ArrayBuffer], { ...(type ? { type } : {}) })
  }
  return new Blob([await new Response(body as ReadableStream).arrayBuffer()], {
    ...(type ? { type } : {}),
  })
}

/** A `Blob` that fetches on first read, so `download()` stays lazy as the contract promises. */
function lazyBlob(open: () => Promise<Response>): Blob {
  return Object.create(new Blob([]), {
    stream: {
      value: () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const body = (await open()).body
            if (!body) {
              controller.close()
              return
            }
            for await (const chunk of body) controller.enqueue(chunk as Uint8Array)
            controller.close()
          },
        }),
    },
    arrayBuffer: { value: async () => (await open()).arrayBuffer() },
    text: { value: async () => (await open()).text() },
    bytes: { value: async () => new Uint8Array(await (await open()).arrayBuffer()) },
  }) as Blob
}

export type { Transformation, UrlOptions }
