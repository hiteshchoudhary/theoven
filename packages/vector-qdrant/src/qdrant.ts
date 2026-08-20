import type { QueryOptions, VectorMatch, VectorRecord, VectorStore } from '@theoven/vector'

export interface QdrantOptions {
  /** e.g. `http://localhost:6333` or your cloud cluster URL. */
  url?: string
  /** Required on Qdrant Cloud, absent on a local instance. */
  apiKey?: string
  /**
   * Vector size. Qdrant fixes this when a collection is created, so it must be known up front —
   * unlike the SQLite driver, which learns it from the first write.
   */
  dimensions: number
  fetcher?: typeof fetch
}

interface QdrantPoint {
  id: string | number
  score: number
  payload?: Record<string, string | number | boolean> | null
}

/**
 * Qdrant, behind the shared contract.
 *
 * This is the adapter that proves the contract is one: a hosted HTTP service with server-side
 * collections and filters is structurally nothing like scanning a SQLite table, and if the
 * interface fits both without bending then it is an abstraction rather than a description of
 * whichever was written first (D14).
 *
 * Two things it has to reconcile:
 *
 * 1. **A namespace is a collection**, created on demand. Qdrant refuses writes to a collection
 *    that does not exist, where SQLite would happily make the row.
 * 2. **Cosine is requested explicitly.** Qdrant defaults to dot product, which ranks by magnitude
 *    as well as direction — so an unnormalised long vector would beat a closer short one, and
 *    `score` would stop meaning what the contract says it means.
 */
export function qdrantVector(options: QdrantOptions): VectorStore {
  const base = (options.url ?? Bun.env.QDRANT_URL ?? 'http://localhost:6333').replace(/\/$/, '')
  const call = options.fetcher ?? fetch
  const known = new Set<string>()

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await call(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { 'api-key': options.apiKey } : {}),
        ...init.headers,
      },
    })

    if (!response.ok && response.status !== 404) {
      throw new Error(`Qdrant answered ${response.status} for ${path}: ${await response.text()}`)
    }
    return response.json()
  }

  /** Qdrant needs the collection to exist first; SQLite does not. The contract hides that. */
  async function ensure(namespace: string): Promise<void> {
    if (known.has(namespace)) return

    const existing = (await request(`/collections/${namespace}`)) as { status?: string }
    if (existing.status !== 'ok') {
      await request(`/collections/${namespace}`, {
        method: 'PUT',
        // Cosine, not the default dot product — see the note above.
        body: JSON.stringify({
          vectors: { size: options.dimensions, distance: 'Cosine' },
        }),
      })
    }
    known.add(namespace)
  }

  /**
   * A deterministic UUID for an arbitrary string id.
   *
   * SHA-256 truncated to 128 bits and formatted as a v5-shaped uuid — deterministic, so re-upserting
   * the same document replaces it rather than duplicating, and collision-resistant enough that two
   * different ids colliding is not a failure mode worth designing around.
   *
   * A 64-bit hash would have been simpler and is not: a collision silently overwrites one document
   * with another, and at a few million vectors that stops being hypothetical.
   */
  function pointId(namespace: string, id: string): string {
    const digest = new Bun.CryptoHasher('sha256').update(`${namespace}:${id}`).digest('hex')
    const hex = digest.slice(0, 32)
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `5${hex.slice(13, 16)}`,
      ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
      hex.slice(20, 32),
    ].join('-')
  }

  /** Equality only, which is all the contract promises (D14: a contract must never invent). */
  function toFilter(filter: QueryOptions['filter']) {
    if (!filter) return undefined
    return {
      must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })),
    }
  }

  return {
    name: 'qdrant',
    raw: { url: base },

    async upsert(namespace: string, records: readonly VectorRecord[]) {
      if (records.length === 0) return
      await ensure(namespace)

      await request(`/collections/${namespace}/points?wait=true`, {
        method: 'PUT',
        body: JSON.stringify({
          points: records.map((record) => ({
            // Qdrant ids must be a uuid or an unsigned integer; the contract promises arbitrary
            // strings. So the caller's id is derived into a stable uuid for Qdrant's key and
            // carried verbatim in the payload, which is what a query reads back.
            id: pointId(namespace, record.id),
            vector: [...record.embedding],
            payload: { ...record.metadata, __id: record.id },
          })),
        }),
      })
    },

    async query(namespace: string, embedding: readonly number[], queryOptions: QueryOptions = {}) {
      await ensure(namespace)

      const body = (await request(`/collections/${namespace}/points/search`, {
        method: 'POST',
        body: JSON.stringify({
          vector: [...embedding],
          limit: queryOptions.k ?? 10,
          with_payload: true,
          filter: toFilter(queryOptions.filter),
          score_threshold: queryOptions.minScore,
        }),
      })) as { result?: QdrantPoint[] }

      return (body.result ?? []).map((point): VectorMatch => {
        const { __id, ...metadata } = point.payload ?? {}
        return {
          id: String(__id ?? point.id),
          // Already a cosine similarity because the collection was created that way, so higher
          // is more similar and no inversion is needed.
          score: point.score,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        }
      })
    },

    async remove(namespace: string, ids: readonly string[]) {
      if (ids.length === 0) return
      await ensure(namespace)

      await request(`/collections/${namespace}/points/delete?wait=true`, {
        method: 'POST',
        body: JSON.stringify({
          filter: { must: [{ key: '__id', match: { any: [...ids] } }] },
        }),
      })
    },

    async clear(namespace: string) {
      await request(`/collections/${namespace}`, { method: 'DELETE' })
      known.delete(namespace)
    },

    async count(namespace: string) {
      await ensure(namespace)
      const body = (await request(`/collections/${namespace}/points/count`, {
        method: 'POST',
        body: JSON.stringify({ exact: true }),
      })) as { result?: { count?: number } }

      return body.result?.count ?? 0
    },
  }
}
