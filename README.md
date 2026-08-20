<h1 align="center">Oven</h1>
<p align="center"><strong>The batteries-included Bun framework.</strong><br>
Express-simple. FastAPI-smart. Everything configurable.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@theoven/core"><img src="https://img.shields.io/npm/v/@theoven/core" alt="npm"></a>
  <a href="https://theoven.app/docs/"><img src="https://img.shields.io/badge/docs-theoven.app-orange" alt="docs"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

```bash
bun create theoven my-app --db sqlite --auth basic
```

That gives you a working app with a database, signup, login and password reset — before you have
provisioned anything at all.

## The idea

Every backend needs the same things: auth, a database, file storage, email, background jobs.
Every backend wires them by hand, badly, again.

Oven makes each one a **brick**. Add it, and you get a small, obvious, fully-typed API on the
request context — and the type only exists if you added it.

```ts title="src/app.ts"
import { createApp } from '@theoven/core'
import { auth } from '@theoven/auth'
import { basicAuth } from '@theoven/auth-basic'
import { db } from '@theoven/db'
import { drizzleSqlite } from '@theoven/db-drizzle'
import { storage, s3Storage } from '@theoven/storage'

export const app = createApp()
  .use(db(drizzleSqlite({ url: './data.db', schema })))
  .use(auth(basicAuth({ db: client, secret: process.env.AUTH_SECRET! })))
  .use(storage(s3Storage({ bucket: 'uploads' })))
```

```ts title="src/routes/users/[id]/avatar.post.ts"
import { z } from 'zod'
import { route } from '../../../route'

export default route(
  {
    auth: true,
    params: z.object({ id: z.uuid() }),
    body: z.object({ file: z.file().max(5_000_000) }),
    response: { 200: z.object({ id: z.uuid(), avatar: z.string() }) },
  },
  async (ctx) => {
    const { key } = await ctx.storage.upload(`avatars/${ctx.params.id}`, ctx.body.file)
    return ctx.db.update(users).set({ avatar: key }).where(eq(users.id, ctx.params.id)).returning()
  },
)
```

Validated, authenticated, typed, and documented at `/docs`. Nothing wired by hand.

The `response` schema is not only documentation — it **filters the body**, so a column the schema
does not declare cannot be sent even when the handler returns the whole row.

## What is in the box

Always on, nothing to install, nothing to order, nothing to forget:

| | | Replaces |
|---|---|---|
| Body parsing | JSON, urlencoded, multipart, text, raw — content-type aware | `body-parser` |
| File uploads | web `File` objects, size and MIME limits | `multer` |
| Cookies | `ctx.cookies`, signed, secure by default outside development | `cookie-parser` |
| Query parsing | arrays and nested keys | `qs` |
| Token capture | `Authorization`, cookie, or `?access_token=` | hand-rolled |
| Request id + logging | structured, request-scoped | `morgan` + `uuid` |
| Errors | RFC 9457 problem+json; async errors caught | `express-async-errors` |
| Graceful shutdown | SIGTERM drains in flight, then closes bricks | hand-rolled |

CORS, rate limiting, compression and security headers ship configured rather than installed.

## Packages

**Core**

| Package | |
|---|---|
| [`@theoven/core`](https://www.npmjs.com/package/@theoven/core) | router, context, validation, OpenAPI, WebSockets, SSE, routers, dependencies |
| [`@theoven/cli`](https://www.npmjs.com/package/@theoven/cli) | `oven dev`, `build`, `routes`, `db`, `worker`, `doctor` |
| [`create-theoven`](https://www.npmjs.com/package/create-theoven) | `bun create theoven my-app` |

**Contracts and adapters** — a small interface package, many implementations

| Contract | Adapters |
|---|---|
| [`@theoven/db`](https://www.npmjs.com/package/@theoven/db) | [`db-drizzle`](https://www.npmjs.com/package/@theoven/db-drizzle) (SQLite, Postgres) · [`db-mongoose`](https://www.npmjs.com/package/@theoven/db-mongoose) |
| [`@theoven/auth`](https://www.npmjs.com/package/@theoven/auth) | [`auth-basic`](https://www.npmjs.com/package/@theoven/auth-basic) (SQL) · [`auth-mongo`](https://www.npmjs.com/package/@theoven/auth-mongo) · [`auth-clerk`](https://www.npmjs.com/package/@theoven/auth-clerk) · [`auth-better`](https://www.npmjs.com/package/@theoven/auth-better) |
| [`@theoven/storage`](https://www.npmjs.com/package/@theoven/storage) | S3, disk · [`storage-bunny`](https://www.npmjs.com/package/@theoven/storage-bunny) · [`storage-imagekit`](https://www.npmjs.com/package/@theoven/storage-imagekit) |

**Standalone bricks**

| Package | |
|---|---|
| [`@theoven/mail`](https://www.npmjs.com/package/@theoven/mail) | Resend, SES, SMTP, and a dev preview inbox |
| [`@theoven/queue`](https://www.npmjs.com/package/@theoven/queue) | jobs, retries, backoff, dead letter, cron — memory, Redis or Postgres |
| [`@theoven/cache`](https://www.npmjs.com/package/@theoven/cache) | tag invalidation and stampede protection — memory or Redis |
| [`@theoven/telemetry`](https://www.npmjs.com/package/@theoven/telemetry) | OpenTelemetry spans named by route pattern |

## Beyond the batteries

```ts
// Group routes: one prefix, one tag, one guard.
const admin = routerFor<typeof app>({ prefix: '/admin', tags: ['admin'], auth: 'staff' })
admin.get('/users', (ctx) => ctx.db.select().from(users))
app.use(admin)
```

```ts
// A per-request value that composes and cleans up after itself.
const tx = dependency('tx', async function* (ctx) {
  const handle = await begin(ctx.db)
  try {
    yield handle
    await handle.commit()
  } catch (error) {
    await handle.rollback()
    throw error
  }
})

export default route({ deps: { tx } }, async (ctx) => {
  await ctx.deps.tx.insert(orders).values(order)
  return { ok: true }
})
```

Also in core: [WebSockets](https://theoven.app/docs/reference/realtime/) upgraded from an
ordinary guarded route, server-sent events, and an OpenAPI document generated from the schemas
you already wrote.

## Docs

**[theoven.app/docs](https://theoven.app/docs/)**

- [Installation](https://theoven.app/docs/start/installation/) · [Tutorial](https://theoven.app/docs/tutorial/first-route/) · [Build a todo API](https://theoven.app/docs/build/)
- [Coming from Express](https://theoven.app/docs/guides/coming-from-express/)
- [Brick catalogue](https://theoven.app/docs/bricks/) — every brick, with what it **cannot** do
- [`llms.txt`](https://theoven.app/llms.txt) · [`llms-full.txt`](https://theoven.app/llms-full.txt) — the whole documentation set for a coding agent

## Status

**0.5.0, on npm.** Core, the CLI and fifteen bricks are published and installable.

Pre-1.0, so APIs can still change between minor versions — that freedom is deliberate while the
contracts settle. See [CHANGELOG.md](./CHANGELOG.md) for what each release changed.

- **On 0.1.2 or earlier — upgrade.** A route file declaring `export const auth = true` was not
  guarded and answered anonymously with a `200`.
- **Upgrading to 0.2.0:** a `response` schema now **filters** the body rather than only checking
  it, and the radix tree exported as `Router` is now `RadixRouter`.
- **Upgrading to 0.3.0:** `/_oven/*` is excluded from the generated OpenAPI document.

## Contributing

```bash
git clone https://github.com/hiteshchoudhary/theoven.git
cd theoven && bun install

bun test              # every package
bun run lint
bun run typecheck
bun run check:docs    # every code sample in the docs and in every README
```

`examples/kitchen-sink` registers every brick in one app and is the integration test — if a change
breaks how two bricks compose, it breaks there.

[`CLAUDE.md`](./CLAUDE.md) records the architecture and every locked decision with its rationale;
[`TODO.md`](./TODO.md) tracks what is done and what is next.

## License

MIT
