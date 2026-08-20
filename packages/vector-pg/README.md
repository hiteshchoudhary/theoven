# @theoven/vector-pg

[![npm](https://img.shields.io/npm/v/@theoven/vector-pg)](https://www.npmjs.com/package/@theoven/vector-pg)

> pgvector as a vector store for Oven.

A store for [`@theoven/vector`](https://www.npmjs.com/package/@theoven/vector), so everything on
`ctx.vector` works unchanged — and `score` stays cosine similarity, where higher is more similar.

```bash
bun add @theoven/vector @theoven/vector-pg
```

```ts
import { vector } from '@theoven/vector'
import { pgVector } from '@theoven/vector-pg'

app.use(vector(pgVector({ url: env.string('DATABASE_URL'), dimensions: 1536 })))
```

`dimensions` is required because pgvector fixes the vector size when the column is created — unlike
the embedded store, which learns it from the first write.

The appeal is one fewer service to operate. The cost is that the index is approximate and
has to be created deliberately — see the brick page.

## Documentation

**[https://theoven.app/docs/bricks/vector/](https://theoven.app/docs/bricks/vector/)**

## License

MIT
