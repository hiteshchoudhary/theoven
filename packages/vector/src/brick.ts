import type { Brick } from '@theoven/core'
import { sqliteVector } from './sqlite'
import type { VectorStore } from './types'

export interface VectorOptions {
  /**
   * The default namespace, when a call does not name one.
   *
   * Named rather than optional-everywhere: a namespace is how two things stay separated, and an
   * implicit global one is how a staging index ends up inside a production search.
   */
  namespace?: string
}

/** Everything `ctx.vector` exposes. */
export interface VectorService {
  readonly driver: string
  upsert(records: Parameters<VectorStore['upsert']>[1], namespace?: string): Promise<void>
  query(
    embedding: readonly number[],
    options?: Parameters<VectorStore['query']>[2] & { namespace?: string },
  ): ReturnType<VectorStore['query']>
  remove(ids: readonly string[], namespace?: string): Promise<void>
  clear(namespace?: string): Promise<void>
  count(namespace?: string): Promise<number>
  /** The store, for a namespace-explicit call or anything the service shape does not cover. */
  readonly store: VectorStore
  readonly raw: unknown
}

/**
 * The vector brick.
 *
 * ```ts
 * app.use(vector(sqliteVector({ url: './vectors.db' })))
 *
 * await ctx.vector.upsert([{ id: 'doc-1', embedding, metadata: { source: 'handbook' } }])
 * const matches = await ctx.vector.query(question, { k: 5, filter: { source: 'handbook' } })
 * ```
 *
 * Defaults to SQLite so retrieval works with nothing to provision, in the same way the database
 * brick defaults to SQLite (D21).
 */
export function vector(
  store: VectorStore = sqliteVector(),
  options: VectorOptions = {},
): Brick<'vector', VectorService> {
  const fallback = options.namespace ?? 'default'

  return {
    name: 'vector',

    setup: () => ({
      driver: store.name,
      store,
      raw: store.raw,

      upsert: (records, namespace) => store.upsert(namespace ?? fallback, records),
      query: (embedding, queryOptions) =>
        store.query(queryOptions?.namespace ?? fallback, embedding, queryOptions),
      remove: (ids, namespace) => store.remove(namespace ?? fallback, ids),
      clear: (namespace) => store.clear(namespace ?? fallback),
      count: (namespace) => store.count(namespace ?? fallback),
    }),

    onShutdown: () => store.close?.(),
  }
}
