# @theoven/db-drizzle

[![npm](https://img.shields.io/npm/v/@theoven/db-drizzle)](https://www.npmjs.com/package/@theoven/db-drizzle)

> Drizzle ORM for Oven — bun:sqlite, Postgres and MySQL.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/db @theoven/db-drizzle drizzle-orm
```

## Usage

```ts
import { drizzleSqlite, drizzlePostgres } from '@theoven/db-drizzle'

db(drizzleSqlite({ url: './data.db', schema }))                    // development
db(drizzlePostgres({ url: env.string('DATABASE_URL'), schema }))   // production
```

Switching databases is that one line. Every query you have written stays the same.

The SQLite provider issues `begin`/`commit`/`rollback` itself, because Drizzle's own bun-sqlite
transaction does **not** roll back an async failure — a test asserts that difference stays visible.

## Documentation

**[https://theoven.app/docs/bricks/db-drizzle/](https://theoven.app/docs/bricks/db-drizzle/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
