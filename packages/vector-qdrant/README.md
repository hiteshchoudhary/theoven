# @theoven/vector-qdrant

[![npm](https://img.shields.io/npm/v/@theoven/vector-qdrant)](https://www.npmjs.com/package/@theoven/vector-qdrant)

> Qdrant as a vector store for Oven.

A store for [`@theoven/vector`](https://www.npmjs.com/package/@theoven/vector), so everything on
`ctx.vector` works unchanged — and `score` stays cosine similarity, where higher is more similar.

```bash
bun add @theoven/vector @theoven/vector-qdrant
```

```ts
import { vector } from '@theoven/vector'
import { qdrantVector } from '@theoven/vector-qdrant'

app.use(vector(qdrantVector({ url: env.string('QDRANT_URL'), dimensions: 1536 })))
```

`dimensions` is required because Qdrant fixes the vector size when the collection is created — unlike
the embedded store, which learns it from the first write.

A namespace is a Qdrant collection, created on demand. Arbitrary string ids are mapped to
deterministic uuids, because Qdrant accepts only uuids and unsigned integers as point ids.

## Documentation

**[https://theoven.app/docs/bricks/vector/](https://theoven.app/docs/bricks/vector/)**

## License

MIT
