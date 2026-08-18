# Oven — Task Tracker

**Current state:** Phase 0 in progress — repo scaffolded, decisions locked. Nothing built yet.
**Next task:** Phase 0 → finish workspace scaffolding, then Phase 1 (router).

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔴 blocker · 💡 idea, not committed

---

## Phase 0 — Foundation

- [x] Lock architectural decisions (see `CLAUDE.md` §2)
- [x] `git init`, monorepo directory skeleton
- [x] `CLAUDE.md`, `TODO.md`
- [x] Root `package.json` with Bun workspaces
- [x] `tsconfig.base.json` (strict) + per-package tsconfig
- [x] `.gitignore`, `LICENSE` (MIT), `README.md`
- [ ] Package stubs: `package.json` + `src/index.ts` for all 7 packages
- [ ] Biome (lint + format) config — chosen over ESLint/Prettier for speed
- [ ] Changesets init (`.changeset/config.json`)
- [ ] GitHub Actions: CI (typecheck, lint, test on Bun) + release (changesets publish)
- [ ] Create GitHub repo, push, claim `@theoven` npm scope
- [ ] Buy `theoven.app`

---

## Phase 1 — Core router (`@theoven/core`)

The foundation. Nothing else can start until §1.1–1.4 are done.

### 1.1 Radix tree router
- [ ] Node structure: static / param (`:id`) / wildcard (`*`) segments
- [ ] `insert(method, path, handler)` with conflict detection on duplicate routes
- [ ] `match(method, pathname)` → `{ handler, params }`, allocation-free on the hot path
- [ ] Correct precedence: static > param > wildcard
- [ ] Trailing-slash + case normalisation policy (configurable, default: strict)
- [ ] `405 Method Not Allowed` with `Allow` header when path matches but method does not
- [ ] Benchmark vs Express / Hono / Elysia — record numbers in `benchmarks/`
- [ ] Tests: 40+ cases covering precedence, params, wildcards, conflicts

### 1.2 Server + Context
- [ ] `createApp()` → `App` with `.use()`, `.listen()`, `.fetch()`
- [ ] `Bun.serve` integration, graceful shutdown on SIGTERM/SIGINT
- [ ] Context: `req`, `params`, `query` (lazy-parsed), `body`, `headers`, `cookies`, `set`, `status`, `redirect`, `log`
- [ ] Body parsing: json, form-data, urlencoded, text, stream — content-type driven, lazy
- [ ] Cookie read/write incl. signed cookies (`Bun.password` / HMAC)
- [ ] Response coercion: object → JSON, string → text, `Response` → passthrough, `Bun.file` → stream
- [ ] Tests

### 1.3 Middleware & hooks
- [ ] Middleware chain with `next()`, correct ordering, short-circuit on early return
- [ ] Lifecycle hooks: `onRequest`, `beforeHandle`, `afterHandle`, `onResponse`, `onError`
- [ ] Scoped middleware (per route group / per directory via `_middleware.ts`)
- [ ] Built-ins: CORS, request logger, request ID, body size limit, compression
- [ ] Tests

### 1.4 Plugin system + type inference 🔴 hardest part of Phase 1
- [ ] `OvenPlugin` interface (see `CLAUDE.md` §4)
- [ ] `.use()` accumulating plugin context types through the chain
- [ ] Plugin lifecycle: `setup` at boot, `onShutdown` on teardown, dependency ordering
- [ ] `defineConfig()` typed sugar that expands config keys → `.use()` calls
- [ ] Type-level tests (`expectTypeOf`) proving unconfigured modules are compile errors

### 1.5 Validation
- [ ] Standard Schema v1 adapter (`schema['~standard'].validate`)
- [ ] Validate `params`, `query`, `body`, `headers` → typed context
- [ ] Response validation (dev-only by default, opt-in for prod)
- [ ] `422` error shape with per-field detail, FastAPI-compatible format
- [ ] Coercion for path/query (string → number/boolean/date)
- [ ] Tests incl. non-Zod validator (Valibot) to prove no lock-in

### 1.6 Errors
- [ ] `OvenError` base + `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `TooManyRequests`, `Internal`
- [ ] RFC 9457 problem+json serialisation
- [ ] Dev vs prod error output (stack traces only in dev)
- [ ] Global `onError` override hook
- [ ] Tests

### 1.7 File-based routing
- [ ] Directory scanner → route table (`[id]`, `[...path]`, `index`, `.get/.post/...`)
- [ ] Route module contract: `default` + `params`/`query`/`body`/`response`/`auth`/`summary`/`tags`
- [ ] `_middleware.ts` cascade
- [ ] Dev-mode hot reload on file add/change/delete
- [ ] Build-time route manifest for prod (no filesystem scan at boot)
- [ ] Clear errors for malformed route files
- [ ] Tests

### 1.8 OpenAPI + docs UI
- [ ] Generate OpenAPI 3.1 from the route table + Zod schemas (`z.toJSONSchema`)
- [ ] Serve spec at `/openapi.json`
- [ ] Scalar UI at `/docs` (fallback: Swagger UI)
- [ ] Security schemes wired from the auth plugin
- [ ] `oven openapi > spec.json` CLI command for client codegen
- [ ] Tests validating the spec against the OpenAPI schema

---

## Phase 2 — Data & auth

### 2.1 `@theoven/db` (drizzle)
- [ ] Config → drizzle instance (postgres / mysql / sqlite via `bun:sqlite`)
- [ ] Connection pooling + health check + graceful close
- [ ] `ctx.db` injection, fully typed from the user's schema
- [ ] Migrations through CLI: `oven db generate | migrate | push | studio`
- [ ] Transaction helper + per-request transaction option
- [ ] Seeding support
- [ ] Tests against real Postgres + SQLite

### 2.2 `@theoven/auth` (better-auth)
- [ ] Config → configured better-auth instance
- [ ] Mount better-auth's routes automatically under `/auth/*`
- [ ] `auth: true` route export → session required, `401` otherwise
- [ ] `ctx.user` / `ctx.session` typed and populated
- [ ] Role / permission guards (`auth: { role: 'admin' }`)
- [ ] OAuth provider config (github, google, …) from plain config
- [ ] Email verification + password reset wired to `@theoven/mail`
- [ ] API-key / bearer-token strategy for service-to-service
- [ ] Auto-wire drizzle adapter when `@theoven/db` is present
- [ ] OpenAPI security schemes contributed to the spec
- [ ] Tests

---

## Phase 3 — Infrastructure modules

### 3.1 `@theoven/storage` (S3)
- [ ] Config → `Bun.S3Client` (AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces)
- [ ] `upload(key, file)`, `download(key)`, `delete(key)`, `exists(key)`, `list(prefix)`
- [ ] `presignedUploadUrl(key, opts)` / `presignedDownloadUrl(key, opts)`
- [ ] Streaming upload/download for large files
- [ ] Multipart upload for very large files
- [ ] Direct-to-S3 browser upload helper (presign + policy)
- [ ] Local-disk driver for dev (no S3 needed to run the app)
- [ ] Multiple named buckets in one config
- [ ] Tests against MinIO in CI

### 3.2 `@theoven/mail`
- [ ] Drivers: Resend, SES, SMTP, `console` (dev), `memory` (test)
- [ ] `mail.send({ to, subject, html | text | template })`
- [ ] Templating (React Email or JSX → HTML) with typed props
- [ ] Dev preview inbox served at `/_oven/mail`
- [ ] Attachments, cc/bcc, reply-to
- [ ] Auto-queue sends when `@theoven/queue` is present
- [ ] Tests

### 3.3 `@theoven/queue`
- [ ] Drivers: Redis (BullMQ-compatible), Postgres, in-memory (dev/test)
- [ ] `defineJob()` with typed payload, `queue.dispatch(name, payload)`
- [ ] Worker process: `oven worker`, concurrency control
- [ ] Retries with backoff, dead-letter queue, job timeouts
- [ ] Delayed / scheduled jobs
- [ ] Cron tasks declared in config
- [ ] Dashboard at `/_oven/queue` (dev)
- [ ] Graceful shutdown: drain in-flight jobs
- [ ] Tests

---

## Phase 4 — CLI & DX (`@theoven/cli`)

- [ ] `bun create oven <name>` — interactive scaffold (module picker, db picker)
- [ ] Templates: minimal, api, full-stack
- [ ] `oven dev` — hot reload, pretty logs, route table on boot
- [ ] `oven build` — bundle + route manifest + tree-shake unused plugins
- [ ] `oven start` — production server
- [ ] `oven routes` — print the route table
- [ ] `oven db <cmd>` — passthrough to drizzle-kit
- [ ] `oven worker` — start queue workers
- [ ] `oven openapi` — emit spec to stdout/file
- [ ] `oven doctor` — validate config + env vars, check service connectivity
- [ ] Typed env-var loading + validation at boot (fail fast with a readable error)

---

## Phase 5 — Docs & launch (`apps/web`)

- [ ] Astro + Starlight setup, theoven.app deployed
- [ ] Landing page: hero, the config pitch, benchmark numbers, comparison table
- [ ] **Tutorial** (FastAPI-style, progressive): first route → validation → errors → db → auth → files → queue → mail → deploy
- [ ] How-to guides: testing, deployment (Docker/Fly/Railway), migrating from Express
- [ ] API reference for every package
- [ ] Runnable code samples verified in CI (docs examples must compile)
- [ ] `examples/minimal` and `examples/kitchen-sink` complete and CI-tested
- [ ] Benchmarks page with reproducible methodology
- [ ] Launch: HN, r/bun, Bun Discord, Twitter/X thread

---

## Backlog / post-1.0

- [ ] 💡 WebSockets + rooms as a plugin (`Bun.serve` has native WS)
- [ ] 💡 Rate limiting plugin (Redis / memory)
- [ ] 💡 Cache plugin (Redis / memory) with `@cached` helpers
- [ ] 💡 Realtime / SSE plugin
- [ ] 💡 Typed RPC client generated from the route table (tRPC-like, no extra syntax)
- [ ] 💡 Admin panel plugin (auto-CRUD from drizzle schema)
- [ ] 💡 OpenTelemetry / observability plugin
- [ ] 💡 i18n plugin
- [ ] 💡 Payments plugin (Stripe)
- [ ] 💡 `oven deploy` to Fly/Railway/Cloudflare Containers
- [ ] 💡 Node adapter (only if the community genuinely demands it — see D9)

---

## Open questions to resolve later

- [ ] Should `ctx` be a plain object or a class with getters? (perf vs ergonomics — benchmark before deciding)
- [ ] Response validation on in production by default, or dev-only?
- [ ] Do we ship our own logger or wrap pino?
- [ ] Monorepo test strategy for services needing Postgres/Redis/MinIO — testcontainers or docker-compose in CI?
