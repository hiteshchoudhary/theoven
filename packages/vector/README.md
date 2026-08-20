# @theoven/vector

[![npm](https://img.shields.io/npm/v/@theoven/vector)](https://www.npmjs.com/package/@theoven/vector)

> Vector search for Oven — an embedded scan, pgvector or Qdrant behind one contract.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun.

## Install

```bash
bun add @theoven/vector
```

## Usage

```ts
import { sqliteVector, vector } from '@theoven/vector'

app.use(vector(sqliteVector({ url: './vectors.db' })))
```

```ts title="src/routes/search.post.ts"
export default async ({ body, vector }) => {
  const embedding = await embed(body.question)
  return vector.query(embedding, { k: 5, filter: { source: 'handbook' } })
}
```

Defaults to SQLite, so retrieval works with **nothing to provision** — the same argument as the
SQLite database default.

## Stores

| | |
| --- | --- |
| `sqliteVector` | in this package; scans in process, no server |
| [`@theoven/vector-pg`](https://www.npmjs.com/package/@theoven/vector-pg) | pgvector, for apps already on Postgres |
| [`@theoven/vector-qdrant`](https://www.npmjs.com/package/@theoven/vector-qdrant) | a dedicated vector database |

`score` is cosine similarity on every one of them — **1 identical, 0 unrelated** — so switching
store does not invert your thresholds.

## The embedded store scans

`sqlite-vec` cannot be loaded under Bun: the bundled SQLite is built without dynamic extension
support. So this compares in JavaScript. Measured at 1536 dimensions:

| vectors | per query |
| --- | --- |
| 1,000 | 3.4 ms |
| 10,000 | 17 ms |
| 50,000 | 88 ms |
| 200,000 | 359 ms |

Linear, and fine to roughly 50,000. Past that, change the store.

## Documentation

**[https://theoven.app/docs/bricks/vector/](https://theoven.app/docs/bricks/vector/)**

## License

MIT
