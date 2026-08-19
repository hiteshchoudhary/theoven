# @theoven/db-mongoose

[![npm](https://img.shields.io/npm/v/@theoven/db-mongoose)](https://www.npmjs.com/package/@theoven/db-mongoose)

> MongoDB through Mongoose, on Oven's database contract.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/db @theoven/db-mongoose mongoose
```

## Usage

```ts
import { mongooseDb } from '@theoven/db-mongoose'

const app = createApp().use(db(mongooseDb({ url: env.string('MONGO_URL') })))

app.get('/users', (ctx) => ctx.db.model('User', userSchema).find())
```

`ctx.db` is a Mongoose `Connection`, not the global singleton, so two apps in one process do
not share state and `app.close()` closes *this* app's connection.

Mongoose scopes transactions to a session rather than a client, so this driver declares no
portable `transaction` and `transaction()` refuses rather than running work unwrapped. Use
`ctx.db.transaction()`. Requires Mongoose 8: Mongoose 9's `bson@7` cannot be imported under Bun.

## Documentation

**[https://theoven.app/docs/bricks/db-mongoose/](https://theoven.app/docs/bricks/db-mongoose/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
