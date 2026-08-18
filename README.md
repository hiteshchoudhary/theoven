<h1 align="center">Oven</h1>
<p align="center"><strong>The batteries-included Bun framework.</strong><br>
Express-simple. FastAPI-smart. Everything configurable.</p>

> ⚠️ **Pre-alpha.** Under active development. Nothing is published to npm yet.

## The idea

Every backend needs the same things: auth, a database, file storage, email, background jobs.
Every backend wires them by hand, badly, again.

Oven makes each one a plugin. You add it, and you get a small, obvious, fully-typed API.

```ts
// oven.config.ts
import { defineConfig } from '@theoven/core'

export default defineConfig({
  routes:  { dir: './src/routes' },
  db:      { driver: 'postgres', url: process.env.DATABASE_URL },
  auth:    { providers: ['github', 'google'] },
  storage: { driver: 's3', bucket: 'uploads' },
  mail:    { driver: 'resend' },
  queue:   { driver: 'redis' },
})
```

```ts
// src/routes/users/[id]/avatar.post.ts
import { z } from 'zod'

export const auth   = true
export const params = z.object({ id: z.uuid() })
export const body   = z.object({ file: z.file() })

export default async ({ params, body, user, storage, db, queue }) => {
  const { url } = await storage.upload(`avatars/${params.id}`, body.file)
  await queue.dispatch('resize-avatar', { url })
  return db.user.update(params.id, { avatar: url })
}
```

Validated. Authenticated. Typed. Documented at `/docs`. No wiring.

## Packages

| Package | What it does |
|---|---|
| `@theoven/core` | Router, context, plugins, validation, OpenAPI |
| `@theoven/auth` | Sessions, OAuth, guards — via better-auth |
| `@theoven/db` | Drizzle + migrations, Postgres/MySQL/SQLite |
| `@theoven/storage` | S3/R2/MinIO — upload, presigned URLs, streaming |
| `@theoven/mail` | Resend/SES/SMTP, templates, dev preview inbox |
| `@theoven/queue` | Background jobs, retries, DLQ, cron |
| `@theoven/cli` | `oven dev`, `oven build`, `bun create oven` |

## Status

See [`TODO.md`](./TODO.md) for the roadmap and [`CLAUDE.md`](./CLAUDE.md) for architecture
and the decisions behind it.

## License

MIT
