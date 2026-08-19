# @theoven/db

[![npm](https://img.shields.io/npm/v/@theoven/db)](https://www.npmjs.com/package/@theoven/db)

> The database contract for Oven — connect, health, close, transactions. Your queries stay native.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/db @theoven/db-drizzle drizzle-orm
```

## Usage

```ts
import { db } from '@theoven/db'
import { drizzleSqlite } from '@theoven/db-drizzle'

const app = createApp().use(db(drizzleSqlite({ url: './data.db', schema })))

app.get('/users', (ctx) => ctx.db.select().from(users))
```

`ctx.db` **is** the Drizzle instance — not a wrapper. The contract covers lifecycle only, so
there is no invented query API to learn and a model that knows Drizzle already knows this.

## Documentation

**[https://theoven.app/docs/bricks/db/](https://theoven.app/docs/bricks/db/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
