# @theoven/cache

[![npm](https://img.shields.io/npm/v/@theoven/cache)](https://www.npmjs.com/package/@theoven/cache)

> Caching for Oven — memory and Redis, with tag invalidation and stampede protection.

## Install

```bash
bun add @theoven/cache
```

## Usage

```ts
import { cache, redisCache } from '@theoven/cache'

const app = createApp().use(cache(redisCache({ url: env.string('REDIS_URL') })))

const user = await ctx.cache.cached(
  `user:${id}`,
  () => ctx.db.select().from(users).where(eq(users.id, id)),
  { ttl: 60_000, tags: [`user:${id}`] },
)

await ctx.cache.invalidate(`user:${id}`)   // clears everything tagged with it
```

Concurrent misses for the same key share **one** call to the producer. Without that, a popular key
expiring means every in-flight request recomputes it at once — the cache stampede, and the reason
a cache can make an outage worse rather than better.

The in-process driver is refused in production: per-instance caches disagree, so a user sees one
value, refreshes, and sees another — a bug that only reproduces under load.

## Documentation

**[https://theoven.app/docs/bricks/cache/](https://theoven.app/docs/bricks/cache/)**

## License

MIT
