# @theoven/ratelimit

[![npm](https://img.shields.io/npm/v/@theoven/ratelimit)](https://www.npmjs.com/package/@theoven/ratelimit)

> Rate limiting that counts across every instance — Redis or Postgres.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun.

## Install

```bash
bun add @theoven/ratelimit
```

## Usage

```ts
import { env } from '@theoven/core'
import { rateLimit, redisStore } from '@theoven/ratelimit'

app.use(
  rateLimit({
    limit: 100,
    window: 60_000,
    store: redisStore({ url: env.string('REDIS_URL') }),
    key: (ctx) => ctx.token ?? ctx.ip,
  }),
)
```

The same options as [core's `rateLimit`](https://theoven.app/docs/reference/middleware/#rate-limiting)
plus a `store`, so moving from the in-process one is a single line.

## Why

Core's limiter counts in one process. Behind a load balancer that means the effective limit is
`limit × instances` — three instances and a limit of 100 admits 300. This counts in one place, so
the number you configured is the number you get.

## Stores

| | |
| --- | --- |
| `redisStore` | one Lua script per check — atomic, one round trip |
| `sqlStore` | `INSERT … ON CONFLICT … RETURNING` in Postgres, for apps that would rather not add Redis |
| `memoryStore` | development parity, so local behaviour matches production |

## Sliding window, not fixed

A fixed window lets someone spend the whole allowance in the last second of one window and again in
the first second of the next — a 2× burst at every boundary, which is exactly when a scraper is
hammering you. The previous window is weighted by how much of it still overlaps.

## When the store is down

Fails **open** by default: a Redis outage should not take the application down with it. Set
`onStoreError: 'deny'` on endpoints where failing open means the abuse succeeds.

## Documentation

**[https://theoven.app/docs/bricks/ratelimit/](https://theoven.app/docs/bricks/ratelimit/)**

## License

MIT
