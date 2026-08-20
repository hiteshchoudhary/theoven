import type { QueryOptions, VectorMatch, VectorRecord, VectorStore } from '@theoven/vector'
import { VectorDimensionError } from '@theoven/vector'

export interface PgVectorOptions {
  url?: string
  client?: Bun.SQL
  table?: string
  /** Vector size. Fixed at table creation, because the column type carries it. */
  dimensions: number
}

/**
 * pgvector, for applications already running Postgres.
 *
 * The appeal is one fewer service to operate. The cost is that the index is approximate and has to
 * be built deliberately — see the limitations on the brick page.
 *
 * ## The operator that matters
 *
 * `<=>` is cosine **distance**: 0 identical, 2 opposite. The contract promises cosine
 * *similarity*, where higher is more similar, so every score is converted with `1 - distance`.
 * Forwarding the raw operator would make `score` mean the opposite of what it means on every
 * other adapter — the exact way a contract stops being one.
 */
export function pgVector(options: PgVectorOptions): VectorStore {
  const table = options.table ?? 'oven_vectors'
  let sql: Bun.SQL | undefined = options.client
  const adopted = options.client !== undefined
  let ready: Promise<void> | undefined

  async function connection(): Promise<Bun.SQL> {
    sql ??= new Bun.SQL(options.url ?? Bun.env.DATABASE_URL ?? '')
    ready ??= (async () => {
      await sql?.unsafe('create extension if not exists vector')
      await sql?.unsafe(`
        create table if not exists ${table} (
          id text not null,
          namespace text not null,
          embedding vector(${options.dimensions}) not null,
          metadata jsonb not null default '{}'::jsonb,
          primary key (namespace, id)
        )
      `)
      await sql?.unsafe(`create index if not exists ${table}_namespace_idx on ${table} (namespace)`)
    })()
    await ready
    return sql
  }

  /** pgvector's text form: `[1,2,3]`. */
  const encode = (embedding: readonly number[]) => `[${embedding.join(',')}]`

  return {
    name: 'pgvector',
    raw: {
      get client() {
        return sql
      },
    },

    async upsert(namespace: string, records: readonly VectorRecord[]) {
      if (records.length === 0) return
      const client = await connection()

      for (const record of records) {
        if (record.embedding.length !== options.dimensions) {
          throw new VectorDimensionError(options.dimensions, record.embedding.length)
        }

        await client.unsafe(
          `insert into ${table} (id, namespace, embedding, metadata) values ($1, $2, $3, $4)
           on conflict (namespace, id) do update set
             embedding = excluded.embedding, metadata = excluded.metadata`,
          /**
           * The metadata **object**, not `JSON.stringify` of it.
           *
           * Bun.SQL encodes a JS object into jsonb itself. Handing it a string makes the column
           * hold a jsonb *string* containing JSON rather than a jsonb object — `jsonb_typeof`
           * returns `string`, and `@>` containment then matches nothing, ever. Metadata filtering
           * would have silently returned no results with no error anywhere.
           */
          [record.id, namespace, encode(record.embedding), record.metadata ?? {}],
        )
      }
    },

    async query(namespace: string, embedding: readonly number[], queryOptions: QueryOptions = {}) {
      const client = await connection()

      // Equality on jsonb via containment — one operator, index-friendly, and exactly as much
      // filtering as the contract promises.
      const filter = queryOptions.filter
      const rows = (await client.unsafe(
        `select id, metadata, 1 - (embedding <=> $2) as score
         from ${table}
         where namespace = $1 ${filter ? 'and metadata @> $4' : ''}
         order by embedding <=> $2
         limit $3`,
        filter
          ? [namespace, encode(embedding), queryOptions.k ?? 10, filter]
          : [namespace, encode(embedding), queryOptions.k ?? 10],
      )) as Array<{
        id: string
        metadata: Record<string, string | number | boolean>
        score: number
      }>

      return rows
        .map((row): VectorMatch => {
          const metadata =
            row.metadata && Object.keys(row.metadata).length > 0 ? row.metadata : undefined
          return metadata
            ? { id: row.id, score: Number(row.score), metadata }
            : { id: row.id, score: Number(row.score) }
        })
        .filter(
          (match) => queryOptions.minScore === undefined || match.score >= queryOptions.minScore,
        )
    },

    async remove(namespace: string, ids: readonly string[]) {
      if (ids.length === 0) return
      const client = await connection()
      // `{a,b}` — Postgres's own array literal. A JS array is serialised as `a,b`, which
      // Postgres rejects with "malformed array literal".
      await client.unsafe(`delete from ${table} where namespace = $1 and id = any($2::text[])`, [
        namespace,
        `{${ids.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(',')}}`,
      ])
    },

    async clear(namespace: string) {
      const client = await connection()
      await client.unsafe(`delete from ${table} where namespace = $1`, [namespace])
    },

    async count(namespace: string) {
      const client = await connection()
      const [row] = (await client.unsafe(
        `select count(*)::int as total from ${table} where namespace = $1`,
        [namespace],
      )) as Array<{ total: number }>
      return row?.total ?? 0
    },

    async close() {
      if (!adopted) await sql?.close()
      sql = undefined
      ready = undefined
    },
  }
}
