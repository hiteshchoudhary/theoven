import { Database } from 'bun:sqlite'
import { dot, normalise } from './math'
import {
  type QueryOptions,
  VectorDimensionError,
  type VectorFilter,
  type VectorMatch,
  type VectorRecord,
  type VectorStore,
} from './types'

export interface SqliteVectorOptions {
  /** Database file, or `:memory:`. */
  url?: string
  /** An existing `bun:sqlite` connection to adopt. */
  client?: Database
  /** Table name. Created at boot if absent. */
  table?: string
}

interface Row {
  id: string
  namespace: string
  embedding: Uint8Array
  metadata: string | null
}

/**
 * Vectors in SQLite, searched by scanning.
 *
 * The point is that there is **nothing to provision** — the same argument as the SQLite database
 * default (D21). RAG works on a laptop on a plane, and the line that changes when it outgrows this
 * is the driver.
 *
 * ## Why it scans rather than indexing
 *
 * `sqlite-vec` is the obvious answer and **cannot be loaded under Bun**: the bundled SQLite is
 * built without dynamic extension support, so `load()` fails with "This build of sqlite3 does not
 * support dynamic extension loading". Pointing Bun at a system SQLite with `setCustomSQLite` is
 * possible, but it is a global that changes every `Database` in the process and needs a
 * platform-specific install — a poor trade for a development default.
 *
 * So it reads the namespace and compares in JavaScript. Measured on 1536-dimension vectors:
 *
 * | vectors | per query |
 * | --- | --- |
 * | 1,000 | 3.4 ms |
 * | 10,000 | 17 ms |
 * | 50,000 | 88 ms |
 * | 200,000 | 359 ms |
 *
 * Linear, and fine to roughly 50,000. Past that the page says to move to pgvector or Qdrant, and
 * means it.
 */
export function sqliteVector(options: SqliteVectorOptions = {}): VectorStore {
  const table = options.table ?? 'oven_vectors'
  const db = options.client ?? new Database(options.url ?? './vectors.db')
  const adopted = options.client !== undefined

  db.exec(`
    create table if not exists ${table} (
      id text not null,
      namespace text not null,
      dims integer not null,
      embedding blob not null,
      metadata text,
      primary key (namespace, id)
    );
    create index if not exists ${table}_namespace_idx on ${table} (namespace);
  `)

  /** Float32Array in, bytes out. Storing text would triple the size and cost a parse per row. */
  const pack = (vector: Float32Array) => new Uint8Array(vector.buffer.slice(0))
  const unpack = (bytes: Uint8Array) =>
    new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)

  function matches(metadata: Record<string, unknown> | undefined, filter?: VectorFilter): boolean {
    if (!filter) return true
    for (const [key, value] of Object.entries(filter)) {
      if (metadata?.[key] !== value) return false
    }
    return true
  }

  return {
    name: 'sqlite',
    raw: db,

    async upsert(namespace, records) {
      if (records.length === 0) return

      const [existing] = db
        .query(`select dims from ${table} where namespace = ? limit 1`)
        .all(namespace) as Array<{ dims: number }>

      const insert = db.prepare(
        `insert into ${table} (id, namespace, dims, embedding, metadata) values (?, ?, ?, ?, ?)
         on conflict (namespace, id) do update set
           dims = excluded.dims, embedding = excluded.embedding, metadata = excluded.metadata`,
      )

      // One transaction for the batch: re-indexing writes thousands of rows, and a commit per row
      // is the difference between a second and a minute.
      db.transaction((batch: readonly VectorRecord[]) => {
        for (const record of batch) {
          const dims = record.embedding.length
          if (existing && dims !== existing.dims) {
            throw new VectorDimensionError(existing.dims, dims)
          }
          insert.run(
            record.id,
            namespace,
            dims,
            pack(normalise(record.embedding)),
            record.metadata ? JSON.stringify(record.metadata) : null,
          )
        }
      })(records)
    },

    async query(namespace, embedding, queryOptions: QueryOptions = {}) {
      const k = queryOptions.k ?? 10
      const query = normalise(embedding)

      const rows = db.query(`select * from ${table} where namespace = ?`).all(namespace) as Row[]

      const scored: VectorMatch[] = []
      for (const row of rows) {
        const metadata = row.metadata
          ? (JSON.parse(row.metadata) as Record<string, string | number | boolean>)
          : undefined

        // Filtered before scoring: a metadata mismatch costs nothing, a dot product over 1536
        // dimensions is the expensive part.
        if (!matches(metadata, queryOptions.filter)) continue

        const stored = unpack(row.embedding)
        if (stored.length !== query.length) continue

        const score = dot(query, stored)
        if (queryOptions.minScore !== undefined && score < queryOptions.minScore) continue

        scored.push(metadata ? { id: row.id, score, metadata } : { id: row.id, score })
      }

      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, k)
    },

    async remove(namespace, ids) {
      if (ids.length === 0) return
      const statement = db.prepare(`delete from ${table} where namespace = ? and id = ?`)
      db.transaction((batch: readonly string[]) => {
        for (const id of batch) statement.run(namespace, id)
      })(ids)
    },

    async clear(namespace) {
      db.run(`delete from ${table} where namespace = ?`, [namespace])
    },

    async count(namespace) {
      const [row] = db
        .query(`select count(*) as total from ${table} where namespace = ?`)
        .all(namespace) as Array<{ total: number }>
      return row?.total ?? 0
    },

    async close() {
      // Only what we opened.
      if (!adopted) db.close()
    },
  }
}
