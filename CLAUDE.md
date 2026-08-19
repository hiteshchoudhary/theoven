# Oven

> The batteries-included Bun framework. Express-simple, FastAPI-smart, everything configurable.

This file is the durable memory for this project. **Read it fully at the start of every session.**
It records what Oven is, every architectural decision we have locked (and why), and the rules
for working in this repo. `TODO.md` tracks what is done and what is next.

---

## 1. What we are building

Oven is a backend framework for **Bun**. It replaces Express and takes inspiration from
**FastAPI**, but is TypeScript-native end to end.

The core promise: **you should never wire infrastructure by hand again.**

Want auth? Add the auth brick. Want a queue? Add the queue brick. Want S3, mail, a database?
Add a brick. Oven does every piece of setup, wiring, connection management and lifecycle
handling for you, then hands you a small, obvious, fully-typed API on the request context.

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

export const auth = true
export const params = z.object({ id: z.uuid() })
export const body   = z.object({ file: z.file() })

export default async ({ params, body, user, storage, db, queue }) => {
  const { url } = await storage.upload(`avatars/${params.id}`, body.file)
  await queue.dispatch('resize-avatar', { url })
  return db.user.update(params.id, { avatar: url })
}
```

That route is automatically validated, authenticated, typed, and documented in OpenAPI at
`/docs`. **That is the entire product thesis.**

### Positioning

| | Express | Fastify | NestJS | FastAPI | **Oven** |
|---|---|---|---|---|---|
| Runtime | Node | Node | Node | Python | **Bun** |
| Batteries (auth/db/queue/mail/s3) | ✗ | ✗ | partial | partial | **✓** |
| Auto OpenAPI | ✗ | brick | brick | ✓ | **✓** |
| Types inferred from schemas | ✗ | partial | partial | ✓ | **✓** |
| File-based routing | ✗ | ✗ | ✗ | ✗ | **✓** |

We are not competing on being the fastest router (Bun makes everything fast). We compete on
**time-from-`bun create` to a production-shaped app**.

---

## 2. Locked decisions

These are settled. Do not re-litigate them in a new session without the user explicitly asking.

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Brand / scope | **Oven**, npm scope `@theoven`, CLI `oven`, docs at **theoven.app** | Unscoped `oven` on npm is taken by a dead 2013 package. Scoped packages are correct for a multi-package framework anyway. `@theoven` matches the domain exactly and carries zero naming risk. |
| D2 | HTTP core | **Own radix-tree router on `Bun.serve`** | Zero runtime deps in core, maximum speed, and total control over the Context shape — which everything else (auth, DI, OpenAPI) hangs off. A third-party router's context would leak into our public API forever. |
| D3 | Route DX | **File-based routing** (`src/routes/**`), schema + handler exported from each file | Zero wiring. The filesystem is the route table. Each file still exports its schemas, so validation, typing and OpenAPI all come from the same place. |
| D4 | Validation | **Zod 4 default, any Standard Schema v1 validator accepted** | Zod 4 has native `z.toJSONSchema()` → OpenAPI generation is free. Standard Schema means users can bring Valibot/ArkType/Effect with no lock-in. |
| D5 | Module wiring | **Brick functions + `.use()` chaining**, with `defineConfig` as typed sugar on top | Chained bricks give bulletproof type inference with a straightforward implementation. `defineConfig` expands to `.use()` calls, so the "everything is config" surface exists over a sound mechanism. Two surfaces, one core. |
| D6 | v1 scope | Core + OpenAPI, Auth (better-auth), DB (drizzle), Storage (S3), Mail, Queue, Cron | All four module groups ship in 1.0. Ambitious, deliberately chosen. |
| D7 | Repo | **Bun workspaces monorepo + changesets** | Bun is fast enough that Turbo/Nx add config without buying speed. Changesets gives independent versioning + changelogs + CI publishing. |
| D8 | Docs | **Astro + Starlight** in `apps/web` — landing page *and* docs in one app | FastAPI won largely on docs. Starlight gives sidebar/search/versioning/dark-mode out of the box and deploys as static. |
| D9 | Runtime | **Bun-only, unapologetically** | Use `Bun.serve`, `Bun.file`, `Bun.password`, `Bun.S3Client`, `bun:sqlite`, `bun:test` directly. Far less code, best perf, clearest story. No Node adapter, no abstraction tax. |
| D10 | License | **MIT** | Maximum adoption. What Express/Fastify/Hono/Elysia all use. |
| D11 | CLI | **Ships in v1** — `bun create oven`, `oven dev/build/routes/db` | A batteries framework lives or dies on the 60-second first-run experience. |
| D12 | Compatibility | **No backward compatibility with anything.** Not Express, not Connect, not `req/res`, not Node streams, not CommonJS. | Oven is a 2026 reset. Every framework carrying Express's shape carries its mistakes. Web-standard `Request`/`Response`, ESM only, async only. Compatibility shims are the single biggest source of API rot — we ship none. |
| D24 | Default database | **Drizzle over `bun:sqlite`**, not raw `bun:sqlite`. | They are not alternatives — Drizzle *runs on* `bun:sqlite`, so this keeps Bun's native driver. The point is portability: raw SQL strings are SQLite-dialect-bound, so a raw default means moving to Postgres rewrites every query. With Drizzle the same query code runs on SQLite, Postgres and MySQL, and switching genuinely is a config change. |
| D25 | Auth storage families | Auth bricks are **per storage family**: `@theoven/auth-basic` (Drizzle/SQL) and `@theoven/auth-mongo` (Mongoose). | SQL and documents are different data models — Mongo has no joins. A single auth brick over a generic storage abstraction would either be lowest-common-denominator or lie. Two bricks, each querying natively, is honest and simpler. |
| D26 | Auth code layout | `@theoven/auth` owns the contract **and** the security-critical flows — argon2id hashing, JWT signing, single-use reset tokens, refresh rotation. Storage bricks implement a seven-method `AuthStore`. | Password handling gets written and audited once. A security fix landing in one brick and not the other is exactly the bug nobody finds. `AuthStore` is shaped for auth's own tables and does **not** contradict D16: db bricks are still lifecycle-only, and user queries stay native. |
| D23 | Vocabulary | **Bricks, not plugins.** `Brick`, `.use(brick)`, `@theoven/db-drizzle` is a brick. | Bricks build the oven — the metaphor is coherent rather than decorative, and a brick is one specific thing with one contract, unlike "plugin" which means everything and nothing. One invented word is a cost worth paying for a name people remember; the docs define it where a reader first meets it. |
| D14 | Auth & DB shape | **Contracts + adapters, in interface packages.** `@theoven/auth` and `@theoven/db` are interface-only; implementations ship as `@theoven/auth-basic`, `@theoven/auth-clerk`, `@theoven/db-drizzle`, `@theoven/db-prisma` and so on. | The original D6 hardcoded better-auth and Drizzle. Nobody should install better-auth to use Clerk, and a framework that marries one ORM ages badly. Core stays purely HTTP. |
| D15 | Per-request brick state | Bricks gain a typed `request()` hook alongside `setup()`. `setup()` contributes a shared service; `request()` contributes per-request state. Both flow into the context type. | `ctx.user` is per-request and must be typed. The alternative — global declaration merging — was already rejected in D5 because it makes `ctx.user` appear in apps with no auth installed. One mechanism, and a db brick can use it for per-request transactions. |
| D16 | DB abstraction depth | **Lifecycle only.** Connect, health, close, transactions, migrations. Queries stay 100% native: `ctx.db` *is* the Drizzle instance or the `PrismaClient`. | A unified query API would be permanently behind every ORM and worse than all of them. It also destroys the LLM story: a model knows Drizzle and Prisma cold and would know an invented Oven API not at all. |
| D17 | Identity shape | `{ id, email?, name?, image?, raw }` — the genuine intersection, plus a `raw` escape hatch typed per adapter. | Normalising roles or organisations means fields that are permanently empty on providers that lack them, and an always-empty field misleads worse than an absent one. |
| D18 | Authorization | **Named policies.** `auth: true` means signed in; anything more is a named function you write against `ctx.user`. | Roles are not normalised (D17), so a portable `role: 'admin'` guard would fail on any provider without roles. A policy is a plain function: testable, greppable, and nameable in the OpenAPI document. |
| D19 | Adapter contract | `identify()` is the only required method. Everything else — mounting routes, sign-out, refresh — is a **declared capability**, checked at boot. | Clerk cannot implement server-side sign-in; better-auth cannot not-mount routes. Requiring both to pretend produces adapters that throw at 3am. Declared capabilities fail at startup, naming the adapter and the feature. |
| D20 | `auth-basic` sessions | Short-lived access JWT (15m) plus a revocable refresh token row. | "JWT" and "logout" pull in opposite directions: a stateless token cannot be revoked, so logout would only clear the client's copy. This is where Laravel Sanctum and devise-jwt both landed — no DB read on the hot path, and logout, sign-out-everywhere and password-change-invalidates-sessions all become real. |
| D21 | Default stack | SQLite by default, swapped to Postgres by changing config. Mail ships in the box, off until configured. | The Laravel/Rails property: `oven create` gives you a working app with signup, login and password reset **before** you have provisioned anything. A framework that needs a Postgres instance to say hello has already lost the first ten minutes. |
| D22 | Agent ergonomics | `llms.txt` + `llms-full.txt` generated from the docs, and an `AGENTS.md` in every scaffold. | The largest win is already banked in D16: models write the ORM they know. These two make the framework itself legible — a fixed URL to paste at a model, and conventions the coding agent reads automatically. |
| D13 | Batteries in core | **Cookies, body parsing, file handling and token capture are always-on core behaviour** — not middleware, not opt-in, not installable. | `app.use(cookieParser())` is a bug in framework design, not a feature. If 100% of real apps need it, it belongs in the runtime. Nothing to install, nothing to order, nothing to forget. |

---

## 2b. Principles

These are the beliefs the decisions above fall out of. Apply them when a new question comes up
that the table does not answer.

### 1. Fresh start. We owe the past nothing.

Oven is designed in 2026 for 2026. There is **no** Express compatibility layer, no
`(req, res, next)` signature, no Connect middleware support, no CommonJS build, no
callback API, no Node stream interop, no polyfills.

Every framework that offered an Express compatibility shim ended up shaped by Express.
We are deliberately not doing that. If someone wants Express, Express exists.

Practically this means:
- **ESM only.** No `require`, no dual build, no `.cjs`.
- **Web standards only.** `Request`, `Response`, `Headers`, `URL`, `FormData`, `ReadableStream`, `File`.
- **Async only.** Every extension point returns a promise or a value; nothing takes a callback.
- **Bun only.** See D9.
- **Breaking changes are fine before 1.0.** We will move fast and change APIs. Semver discipline
  starts at 1.0, not before. Do not add a deprecation path for something that shipped last week.

### 2. If every app needs it, it is not a brick.

Express made you assemble a working server from parts: `body-parser`, `cookie-parser`, `multer`,
`cors`, `morgan`. That was never a real choice — it was homework. Oven ships those behaviours in
core, always on, correctly ordered, with no install and no registration.

**Always on, zero configuration, cannot be forgotten:**

| Behaviour | What you get | Express equivalent you no longer install |
|---|---|---|
| **Cookie parsing** | `ctx.cookies.get(name)`, `.set(name, val, opts)`, `.delete()`, signed cookies | `cookie-parser` |
| **Body parsing** | `ctx.body` — content-type aware: JSON, urlencoded, multipart, text, raw. Lazy, size-limited, never blocks a route that does not read it | `body-parser`, `express.json()` |
| **File handling** | Uploads arrive as web `File` objects in `ctx.body`. Streaming, size/type limits, temp-file spill for large uploads | `multer` |
| **Token capture** | `ctx.token` — pulled automatically from `Authorization: Bearer`, cookie, or `?token=`, in that precedence. Present with or without the auth brick | hand-rolled every time |
| **Query parsing** | `ctx.query`, lazily parsed, with arrays and nested keys | `qs` |
| **Request ID + logging** | `ctx.id`, `ctx.log` — structured, request-scoped | `morgan` + `uuid` |
| **Errors** | Thrown errors become RFC 9457 responses. Async errors caught automatically | Express needs `express-async-errors` |
| **Graceful shutdown** | SIGTERM drains in-flight requests and closes brick resources | hand-rolled every time |

The rule: **if it appears in more than 80% of real apps, it goes in core with no switch.**
Things that vary by app (CORS policy, rate limits, compression) stay configurable but still
ship in the box — configured, not installed.

### 3. Lazy, not eager.

Always-on must not mean always-paid. Body is not parsed until `ctx.body` is read. Query is not
parsed until `ctx.query` is read. Cookies are not parsed until touched. A route that returns a
string does zero parsing work. Measure this — it is a benchmark requirement, not an aspiration.

### 5. Contracts are small; adapters are many.

Anywhere Oven integrates with something outside itself — a database, an auth provider, a mail
service — the shape is the same:

- **A contract package** (`@theoven/db`) defining the smallest interface that is genuinely
  common across implementations, with a **`raw` escape hatch** for everything else.
- **Adapter packages** (`@theoven/db-drizzle`) implementing it.
- **Declared capabilities** for anything not universal, checked at boot rather than at request
  time.

The test of a contract is whether a second, structurally different implementation fits it
without changes. `db-drizzle` alone proves nothing; `db-drizzle` plus `db-prisma` proves the
abstraction is real. This is the same reason the validator contract is exercised with Valibot
and not only Zod.

What a contract must never do is invent. If two providers genuinely disagree — Clerk hosts its
sign-in page, better-auth mounts routes — the contract exposes that difference rather than
papering over it with a method one of them has to fake.

### 4. Types are the documentation.

If a user needs to read docs to know a property exists, we failed. Autocomplete on `ctx` should
teach the framework.

---

## 3. Repo layout

```
oven/
├─ packages/
│  ├─ core/         @theoven/core     router, context, bricks, validation, OpenAPI
│  ├─ auth/         @theoven/auth     better-auth integration
│  ├─ db/           @theoven/db       drizzle integration + migrations
│  ├─ storage/      @theoven/storage  S3 / R2 / MinIO via Bun.S3Client
│  ├─ mail/         @theoven/mail     Resend / SES / SMTP + dev preview inbox
│  ├─ queue/        @theoven/queue    background jobs, retries, DLQ, cron
│  └─ cli/          @theoven/cli      bin: `oven`, plus `bun create oven`
├─ apps/
│  └─ web/          theoven.app — Astro + Starlight (landing + docs)
├─ examples/
│  ├─ minimal/      smallest possible app
│  └─ kitchen-sink/ every module enabled, used as an integration test
├─ CLAUDE.md        ← you are here
└─ TODO.md          ← detailed task tracker, updated every session
```

**Dependency rule:** `core` depends on nothing but Bun and Zod. Every other package depends on
`core` and never on a sibling. If two modules need to share something, it belongs in `core`.

---

## 4. Architecture

### Request lifecycle

```
Bun.serve fetch
  → router.match(method, pathname)        radix tree, params extracted
  → build Context                          brick-contributed properties
  → run middleware chain                   onRequest → auth → custom
  → validate params/query/body             Standard Schema, 422 on failure
  → handler(ctx)
  → validate + serialize response
  → onResponse / onError hooks
```

### The Context

The Context object is the single argument every handler receives. It is assembled from
brick contributions and is **typed by what is registered** — if the storage brick is not
in use, `ctx.storage` does not exist at the type level.

Core always provides: `req`, `params`, `query`, `body`, `headers`, `cookies`, `set`, `log`,
`redirect`, `status`.

### Brick contract

A brick is a function returning a descriptor. This is the extension point for everything.

```ts
export interface Brick<Name extends string, Ctx> {
  name: Name
  setup(app: App): Promise<Ctx> | Ctx    // build the service, once, at boot
  onRequest?(ctx): void | Promise<void>  // per-request hook
  onShutdown?(): Promise<void>           // graceful teardown
  routes?: RouteDef[]                    // routes the brick injects (e.g. /auth/*)
  openapi?: OpenAPIFragment              // schema contributions
}
```

`setup()` returns the object that becomes `ctx.<name>`. Types flow from that return value
through `.use()` chaining, which is why inference is reliable (D5).

### File-based routing conventions

```
src/routes/index.get.ts              → GET  /
src/routes/users/index.get.ts        → GET  /users
src/routes/users/[id].get.ts         → GET  /users/:id
src/routes/files/[...path].get.ts    → GET  /files/*
src/routes/_middleware.ts            → middleware for this dir and below
```

Each route file exports: `default` (the handler) and optionally `params`, `query`, `body`,
`response`, `auth`, `summary`, `tags`.

---

## 5. Conventions

- **TypeScript strict.** No `any` in public API surfaces. `unknown` + narrowing instead.
- **Bun APIs directly.** No polyfills, no `node:` imports where a Bun API exists.
- **`bun:test`** for all tests. Test files live next to source as `*.test.ts`.
- **Errors:** throw `OvenError` subclasses (`BadRequest`, `Unauthorized`, `NotFound`, …).
  The error handler maps them to RFC 9457 problem+json responses.
- **No default exports** from packages except route files (where the convention requires it).
- **Every public API needs a docs page** in `apps/web` before its task is marked done.
- **Changesets:** every user-facing change ships with `bun changeset`.

---

## 5b. Every brick ships with a catalogue page

A brick is not done until `apps/web/src/content/docs/bricks/<name>.mdx` exists. Not "before
release" — in the same commit, because a brick whose page comes later is a brick nobody can
use and nobody reviews the ergonomics of.

**Every page uses the same headings, in this order.** The consistency is the feature: a reader
who has seen one page knows where to look on the next, and a coding agent can find "what
endpoints does this add" without inference. A section that does not apply says so — `Creates
files: none` — rather than being dropped, because a missing heading is ambiguous where an
explicit "none" is not.

```mdx
---
title: <brick name, as it is imported>
description: <one sentence, what it does>
sidebar:
  order: <n>
---

| | |
| --- | --- |
| **Package** | @theoven/<name> |
| **Adds to context** | ctx.<name>, ctx.<per-request state> |
| **Endpoints** | the paths it mounts, or "none" |
| **Creates files** | migrations, config, generated code — or "none" |
| **Creates tables** | its own tables — or "none" |
| **Status** | shipped | in progress | planned |

## Install          bun add, and the .use() line
## What it does     two or three sentences, no marketing
## Endpoints        a table: method, path, purpose, auth — or "This brick adds no endpoints."
## Configuration    a worked example, then a table of every option with its default
## What it creates  files written, tables migrated, what to commit — or "Nothing."
## Usage            typed examples of the common cases
## Capabilities     what it supports and what it does not (D19), and what fails at boot
## Limitations      the honest list; where it will not fit
## How it is verified   what the tests actually prove
```

Two rules for the content:

- **State what it cannot do.** A brick page that only lists capabilities is an advertisement.
  `auth-clerk` cannot sign a user in from the server; say so on the page, not in a support
  thread.
- **Show the files it writes.** Anything that touches a user's repository — a migration, a
  generated schema, a config file — is listed by path, so nobody discovers it in `git status`.

## 6. Commands

```bash
bun install              # install all workspaces
bun run build            # build all packages
bun test                 # run all tests
bun run docs:dev         # Astro docs site locally
bun run example:minimal  # run the minimal example app
bun changeset            # record a version bump
```

---

## 7. Session protocol

At the **start** of a session:
1. Read this file, then `TODO.md`.
2. Confirm which phase we are in and what the next unchecked task is.

At the **end** of a session:
1. Tick off completed tasks in `TODO.md` and add any new ones discovered.
2. If a decision was made, add it to the **Locked decisions** table above with its rationale.
3. Update the "Current state" line in `TODO.md`.

**Do not** start a new phase without the user's go-ahead. **Do not** silently change a locked
decision — surface it, explain the tradeoff, and let the user decide.
