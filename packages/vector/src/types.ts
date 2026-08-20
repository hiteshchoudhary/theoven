/** A stored vector, its id, and whatever you want to filter or display later. */
export interface VectorRecord {
  id: string
  embedding: readonly number[]
  /** Flat values only — see `VectorFilter` for why. */
  metadata?: Record<string, string | number | boolean> | undefined
}

/** A result, ordered most similar first. */
export interface VectorMatch {
  id: string
  /**
   * Cosine similarity: **1 is identical, 0 is unrelated, -1 is opposite.**
   *
   * Normalised deliberately. Engines disagree — some return a distance where lower is better,
   * others a similarity where higher is. Passing each through untouched would make `score` mean
   * opposite things depending on which adapter was registered, which is a contract that lies
   * rather than a contract that abstracts.
   */
  score: number
  metadata?: Record<string, string | number | boolean> | undefined
}

/**
 * Equality on flat metadata, and nothing more.
 *
 * Every engine supports this. Past it they diverge hard — Qdrant has nested boolean trees,
 * Pinecone has `$gt`/`$in` operators, pgvector has all of SQL. Inventing a query language over
 * that would be worse than all of them and permanently behind each, so anything richer goes
 * through `raw` (D14: a contract must never invent).
 */
export type VectorFilter = Record<string, string | number | boolean>

export interface QueryOptions {
  /** How many matches to return. Default 10. */
  k?: number
  filter?: VectorFilter | undefined
  /** Drop matches below this similarity. Applied after the engine's own ranking. */
  minScore?: number | undefined
}

/**
 * The smallest interface that is genuinely common to an embedded scan, pgvector, and a hosted
 * vector database.
 *
 * `namespace` is the unit of separation: a Pinecone namespace, a Qdrant collection, a column in
 * SQL. Every engine has the concept under some name, which is what makes it contract material.
 */
export interface VectorStore {
  name: string
  /** Insert or replace by id. Replacing rather than erroring is what makes re-indexing safe. */
  upsert(namespace: string, records: readonly VectorRecord[]): Promise<void>
  query(
    namespace: string,
    embedding: readonly number[],
    options?: QueryOptions,
  ): Promise<VectorMatch[]>
  remove(namespace: string, ids: readonly string[]): Promise<void>
  /** Everything in a namespace. Used by re-indexing, and by tests. */
  clear(namespace: string): Promise<void>
  /** How many vectors a namespace holds. */
  count(namespace: string): Promise<number>
  /** The engine underneath, for anything this contract deliberately does not cover. */
  readonly raw: unknown
  close?(): Promise<void>
}

/** Thrown when a vector's length does not match what the namespace already holds. */
export class VectorDimensionError extends Error {
  override name = 'VectorDimensionError'
  constructor(expected: number, received: number) {
    super(
      `This namespace stores ${expected}-dimension vectors and received ${received}. ` +
        'Embeddings from two different models cannot share a namespace.',
    )
  }
}
