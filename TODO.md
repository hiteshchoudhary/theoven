# Oven — Task Tracker

**Current state:** Phases 1.1, 1.2 and 1.3 done — router, server, context, errors, logger, response
coercion, graceful shutdown, and the always-on batteries. **425 tests green**, typecheck and lint clean. Benchmarked against
Hono, Elysia, Fastify and Express at both dispatch and socket level. Docs site scaffolded and
building (11 pages). GitHub repo live, `@theoven` npm org claimed.
**Next task:** Phase 1.4 — middleware and lifecycle hooks.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔴 blocker · 💡 idea, not committed

---

## Ground rules for every task in this file

Read `CLAUDE.md` §2b before working. The short version:

1. **No backward compatibility with anything.** No Express shim, no `(req, res, next)`, no Connect
   middleware, no CommonJS, no callbacks, no Node streams. Web standards + ESM + async only.
   Breaking changes before 1.0 are expected and encouraged — never add a deprecation path for
   something that shipped last week.
2. **If every app needs it, it ships in core, always on.** Cookies, body parsing, file uploads,
   token capture, query parsing, request IDs, async error catching, graceful shutdown. No
   `app.use(...)` to enable them. No way to forget them.
3. **Always-on must be lazy.** Nothing is parsed until it is read. This is a benchmark
   requirement, not an aspiration — a route returning a string must do zero parsing work.
4. **Types are the documentation.** Autocomplete on `ctx` should teach the framework.

---

## Phase 0 — Foundation

- [x] Lock architectural decisions (`CLAUDE.md` §2)
- [x] `git init`, monorepo directory skeleton
- [x] `CLAUDE.md` (architecture + principles), `TODO.md`
- [x] Root `package.json` with Bun workspaces
- [x] `tsconfig.base.json` (strict) + root tsconfig
- [x] `.gitignore`, `LICENSE` (MIT), `README.md`
- [x] Package stubs: `package.json` + `src/index.ts` for all 7 packages
- [x] Biome config (lint + format) — chosen over ESLint/Prettier for speed
- [x] Changesets init (`.changeset/config.json`)
- [x] GitHub Actions: CI (typecheck, lint, `bun test`) + release (changesets publish)
- [x] GitHub repo created and pushed: `hiteshchoudhary/theoven`
- [x] `@theoven` npm org claimed (owner: hiteshchoudhary); local `npm login` working
- [ ] **You:** buy `theoven.app` and point it at the Cloudflare Pages project
- [ ] **You:** rotate the npm token that was pasted into chat, then add the new one as the
      `NPM_TOKEN` GitHub Actions secret so releases can publish

---

## Phase 1 — Core (`@theoven/core`)

Everything else depends on this. Do not start Phase 2 until Phase 1 is done and benchmarked.

### 1.1 Radix tree router ✅

`packages/core/src/router/` — 50 tests, all green.

- [x] Node structure: static / param (`:id`) / wildcard (`*name`) segments
- [x] `insert(method, path, payload)` with conflict detection: duplicate routes, non-final
      wildcards, and two names claiming the same parameter position all throw at registration
- [x] `find(method, path)` → `{ found, payload, params }`, one allocation on a static hit
      (param stacks and the `Allow` list are reusable instance scratch space)
- [x] Precedence: static > param > wildcard
- [x] **Backtracking** — `/files/public/list` + `/files/:id/download` correctly answers
      `/files/public/download`. This is the case greedy routers get wrong.
- [x] `405` support: a miss reports which methods *are* registered on that path, so the server
      can send a correct `Allow` header instead of a lazy 404
- [x] Trailing-slash policy: `/a` and `/a/` are the same route
- [x] Percent-decoding of captured params, lazy (skipped unless the segment contains `%`),
      tolerant of malformed escapes
- [x] `routes()` introspection for `oven routes` and boot logging
- [x] Tests: 50 cases — precedence, backtracking, params, wildcards, conflicts, unicode,
      encoded segments, 405 collection, 1500-route table
- [x] Micro-benchmark in `benchmarks/router.bench.ts` — 11.9M static lookups/s,
      8.6M single-param/s, 4.9M with backtracking
- [x] Comparative benchmark vs Hono / Elysia — see `benchmarks/README.md`. Express excluded on
      purpose: it has no `Request` entry point, so the comparison would not be like-for-like
- [x] Socket-level throughput benchmark with a real load generator, including Express and
      Fastify — `benchmarks/http.bench.ts`. Oven ~6x Express, ~1.35x Fastify, level with
      Elysia and Hono. Confirms the dispatch-level Elysia gap is worth 2.5% at the socket

### 1.2 Server + Context ✅

`packages/core/src/{app,context,response,errors,logger}.ts` — 173 tests.

- [x] `createApp()` → `App` with `.route()`/`.get()`/`.post()`/…, `.fetch()`, `.listen()`, `.close()`
- [x] `Bun.serve` integration; `fetch()` also dispatches directly, so **tests exercise the exact
      pipeline the socket uses** without binding a port
- [x] **Graceful shutdown** — SIGTERM/SIGINT stop new work, in-flight requests drain, shutdown
      hooks run, socket closes. Requests arriving mid-drain get `503` + `Retry-After` rather
      than a dropped connection. Times out instead of hanging forever
- [x] Context as a class: lazy getters need a prototype, and a shared hidden class keeps
      construction to one allocation (resolves the open question below)
- [x] `ctx.id` — adopted from `x-request-id` when a proxy set one, generated otherwise, **lazily**
- [x] `ctx.log` — request-scoped child logger with the id bound, derived on first read
- [x] `ctx.set` / `ctx.append` / `ctx.status` / `ctx.redirect` / `ctx.url` / `ctx.path` / `ctx.ip`
- [x] Response coercion: object/array/number/boolean → JSON, string → text, `Response` →
      passthrough, `Blob`/`Bun.file` → streamed, `ReadableStream` → streamed, `ArrayBuffer` →
      binary, `URL` → redirect, `null` → 204. Bodiless statuses (204/205/304) drop the body
      rather than throw
- [x] `HEAD` served from the `GET` handler per RFC 9110; `OPTIONS` answered automatically with
      a correct `Allow`; unknown methods get `501`
- [x] Errors: `OvenError` + 12 subclasses, RFC 9457 problem+json, async throws caught
      automatically, `onError` override that cannot mask the original failure
- [x] **Production leak test** — internal error messages and connection strings never reach the
      client outside development
- [x] Logger: levels, JSON and pretty formats, child binding, circular-safe fields. Ships in
      core but `createApp({ logger })` accepts pino or anything matching the interface
      (resolves the open question below)
- [x] `ctx.headers` deferred to §1.3, where the rest of the request accessors live
- [x] 173 tests covering all of the above

**Note:** `app.options()` (the verb) collided with a private `options` field — the field silently
shadowed the method on the instance. Renamed to `settings`, with a comment so it stays fixed.

### 1.3 Always-on batteries ✅

`packages/core/src/{body,cookies,query,token}.ts` — 202 tests. Every item below works with
**zero configuration and zero registration**, and none of it runs until it is read.

**Body parsing** (replaces `body-parser`)
- [x] `ctx.body` — lazy, memoised, content-type dispatched: JSON, `+json`, urlencoded,
      multipart, `text/*`, and raw bytes for anything else
- [x] `ctx.rawBody` — byte-exact input for webhook signature checks. Reading it first is safe;
      `ctx.body` then parses from those bytes rather than a consumed stream
- [x] Size limits enforced **by counting bytes as they arrive**, not by trusting
      `Content-Length` — the header is client-supplied and often absent
- [x] Malformed JSON → `400` with the parser's own message; empty body → `undefined`, not a throw
- [x] Tests: large bodies, wrong content-type, truncated payloads, a lying `Content-Length`

**File handling** (replaces `multer`)
- [x] Multipart uploads arrive as web `File` objects in `ctx.body`; `ctx.files()` for a
      by-field view
- [x] Streamed rather than buffered — Bun's `FormData` spills large parts to disk, so we
      deliberately do not buffer multipart first
- [x] Per-file limit, total limit, file-count limit, MIME allowlist with `image/*` wildcards
      → `413`/`415`
- [x] Tests including a path-traversal filename, which is preserved verbatim and never resolved
- [ ] Zod integration (`z.file()`) — waits on §1.6
- [ ] Direct handoff to `@theoven/storage` without a round trip through memory — waits on §3.1

**Cookies** (replaces `cookie-parser`)
- [x] `ctx.cookies.get/has/all/set/delete`, lazily parsed
- [x] Secure defaults: `httpOnly` and `SameSite=Lax` unless opted out, `Secure` outside
      development, and `Secure` forced when `SameSite=None` since browsers drop it otherwise
- [x] Signed cookies (HMAC-SHA256) with a **constant-time** signature comparison; a tampered
      cookie reads as absent rather than as a value with a flag
- [x] Signing without a configured secret throws instead of silently not signing

**Token capture** (replaces the snippet everyone rewrites)
- [x] `ctx.token` — `Authorization` header → cookie → query string, in that order
- [x] Works with **no auth module installed**: capture is core, verification is the plugin's job
- [x] `ctx.tokenSource` and `ctx.tokenScheme`; `ctx.basicAuth` decodes `Basic` credentials
- [x] Query capture can be disabled (`token: { query: null }`) — query strings reach access
      logs, history and `Referer`
- [x] `redactToken()` for logging; `Context.toJSON()` omits credentials entirely, with tests
      asserting no token or cookie can reach an error response

**Query parsing** (replaces `qs`)
- [x] `ctx.query`, lazy. Repeated keys → arrays, `a[b]=1` → nested, `a[]=1` → array
- [x] Depth and key-count limits, null-prototype result
- [x] `__proto__`, `constructor` and `prototype` dropped wherever they appear — the `qs` CVE
      class, tested against real pollution attempts

**Headers, IP, misc**
- [x] `ctx.header(name)` returns `undefined` rather than `null`, case-insensitive
- [x] `ctx.ip` honours `X-Forwarded-For` **only** when `trustProxy` is set, counting hops from
      the right so a client cannot prepend its way to a spoofed address
- [x] `ctx.url` parsed once and shared; `ctx.accepts()` with `q`-weight and wildcard support

**Note:** `ctx.headers` was renamed to `ctx.responseHeaders`. With request headers on the same
object a bare `ctx.headers` is a coin flip every time you read it.

**Bug found while testing:** `Headers` trims trailing whitespace, so `Authorization: Bearer `
arrived as the bare word `Bearer` and was captured as a token whose value was literally
`"Bearer"`. Bare scheme names are now rejected.

### 1.4 Middleware & hooks
- [ ] Middleware chain with `next()`, correct ordering, short-circuit on early return
- [ ] Lifecycle hooks: `onRequest`, `beforeHandle`, `afterHandle`, `onResponse`, `onError`
- [ ] Directory-scoped middleware via `_middleware.ts`
- [ ] **Async errors caught automatically** — no `express-async-errors` equivalent needed
- [ ] Configured-not-installed built-ins: CORS, compression, rate limit, request logging, security headers
- [ ] Tests

### 1.5 Plugin system + type inference 🔴 hardest part of the phase
- [ ] `OvenPlugin` interface (`CLAUDE.md` §4)
- [ ] `.use()` accumulating plugin context types through the chain
- [ ] Plugin lifecycle: `setup` at boot, dependency ordering, `onShutdown` on teardown
- [ ] Plugins can contribute routes (e.g. `/auth/*`) and OpenAPI fragments
- [ ] `defineConfig()` typed sugar expanding config keys → `.use()` calls
- [ ] Type-level tests (`expectTypeOf`) proving an unconfigured module is a **compile error**

### 1.6 Validation
- [ ] Standard Schema v1 adapter (`schema['~standard'].validate`)
- [ ] Validate `params`, `query`, `body`, `headers` → narrowed context types
- [ ] Response validation (dev-only by default; decide prod default — open question)
- [ ] `422` error shape with per-field detail
- [ ] Coercion for path/query (string → number/boolean/date)
- [ ] Tests incl. a non-Zod validator (Valibot) to prove no lock-in

### 1.7 Errors
- [ ] `OvenError` base + `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `Payload TooLarge`, `UnsupportedMediaType`, `TooManyRequests`, `Internal`
- [ ] RFC 9457 problem+json serialisation
- [ ] Dev vs prod output — stack traces and internal messages never leak in prod
- [ ] Global `onError` override
- [ ] Tests, including a redaction test for tokens/passwords/cookies in error output

### 1.8 File-based routing
- [ ] Directory scanner → route table (`[id]`, `[...path]`, `index`, `.get`/`.post`/…)
- [ ] Route module contract: `default` + `params`/`query`/`body`/`response`/`auth`/`summary`/`tags`
- [ ] `_middleware.ts` cascade
- [ ] Dev hot reload on add/change/delete
- [ ] Build-time route manifest for prod (no filesystem scan at boot)
- [ ] Actionable errors for malformed route files (name the file and the mistake)
- [ ] Tests

### 1.9 OpenAPI + docs UI
- [ ] OpenAPI 3.1 generated from the route table + schemas (`z.toJSONSchema`)
- [ ] Spec at `/openapi.json`, Scalar UI at `/docs`
- [ ] File-upload routes documented correctly as `multipart/form-data`
- [ ] Security schemes contributed by the auth plugin
- [ ] `oven openapi` CLI command for client codegen
- [ ] Tests validating output against the OpenAPI meta-schema

---

## Phase 2 — Data & auth

### 2.1 `@theoven/db` (drizzle)
- [ ] Config → drizzle instance (postgres / mysql / sqlite via `bun:sqlite`)
- [ ] Pooling, health check, graceful close
- [ ] `ctx.db` typed from the user's schema
- [ ] `oven db generate | migrate | push | studio`
- [ ] Transaction helper + optional per-request transaction
- [ ] Seeding
- [ ] Tests against real Postgres + SQLite

### 2.2 `@theoven/auth` (better-auth)
- [ ] Config → configured better-auth instance
- [ ] Auto-mount better-auth routes under `/auth/*`
- [ ] Consumes core's `ctx.token` (capture is core, verification is here)
- [ ] `export const auth = true` → session required, `401` otherwise
- [ ] `ctx.user` / `ctx.session` typed and populated
- [ ] Role/permission guards (`auth: { role: 'admin' }`)
- [ ] OAuth providers from plain config
- [ ] Email verification + password reset wired to `@theoven/mail`
- [ ] API-key / service-token strategy
- [ ] Auto-wires the drizzle adapter when `@theoven/db` is present
- [ ] OpenAPI security schemes
- [ ] Tests

---

## Phase 3 — Infrastructure modules

### 3.1 `@theoven/storage` (S3)
- [ ] Config → `Bun.S3Client` (S3, R2, MinIO, Spaces)
- [ ] `upload`, `download`, `delete`, `exists`, `list`
- [ ] `presignedUploadUrl` / `presignedDownloadUrl`
- [ ] Streaming + multipart for large files
- [ ] Zero-copy handoff from core's file handling (§1.3)
- [ ] Browser direct-upload helper (presign + policy)
- [ ] Local-disk driver for dev — the app must run with no S3
- [ ] Multiple named buckets
- [ ] Tests against MinIO in CI

### 3.2 `@theoven/mail`
- [ ] Drivers: Resend, SES, SMTP, `console` (dev), `memory` (test)
- [ ] `mail.send({ to, subject, html | text | template })`
- [ ] Typed templates (React Email / JSX → HTML)
- [ ] Dev preview inbox at `/_oven/mail`
- [ ] Attachments, cc/bcc, reply-to
- [ ] Auto-queues when `@theoven/queue` is present
- [ ] Tests

### 3.3 `@theoven/queue`
- [ ] Drivers: Redis, Postgres, in-memory (dev/test)
- [ ] `defineJob()` with typed payload; `queue.dispatch(name, payload)`
- [ ] `oven worker` with concurrency control
- [ ] Retries with backoff, DLQ, job timeouts
- [ ] Delayed / scheduled jobs
- [ ] Cron tasks in config
- [ ] Dev dashboard at `/_oven/queue`
- [ ] Graceful shutdown drains in-flight jobs
- [ ] Tests

---

## Phase 4 — CLI & DX (`@theoven/cli`)

- [ ] `bun create oven <name>` — interactive scaffold (module + db picker)
- [ ] Templates: minimal, api, full-stack
- [ ] `oven dev` — hot reload, pretty logs, route table on boot
- [ ] `oven build` — bundle + route manifest + tree-shake unused plugins
- [ ] `oven start` — production server
- [ ] `oven routes` — print the route table
- [ ] `oven db <cmd>` — drizzle-kit passthrough
- [ ] `oven worker`, `oven openapi`
- [ ] `oven doctor` — validate config + env, check service connectivity
- [ ] Typed env loading + validation at boot, failing fast with a readable error

---

## Phase 5 — Docs & launch (`apps/web`)

- [x] Astro + Starlight scaffolded in `apps/web`, builds to `apps/web/dist` (11 pages,
      Pagefind search, sitemap, `_headers` for caching + security)
- [~] Cloudflare Pages: build fixed via `scripts/cloudflare-build.sh`. Pages sniffs lockfiles
      and looks for `bun.lockb` (Bun's pre-1.2 binary format); we ship `bun.lock` (text), so it
      fell through to npm, which cannot parse `workspace:*`. Set `SKIP_DEPENDENCY_INSTALL=1`
      and drive Bun ourselves
- [x] Pages deploy green at theoven.pages.dev
- [x] Pages build output directory switched to `dist`; deploy green with landing + docs
- [x] Internal link checking wired into `scripts/build-site.sh` and CI. Mounting the docs under
      `/docs` produced three separate classes of broken link that all passed review; the crawl
      catches every one and fails the build
- [ ] Point theoven.app at the Pages project
- [ ] Move the deploy to GitHub Actions + Wrangler so the build config lives in the repo
      rather than depending on the `SKIP_DEPENDENCY_INSTALL` dashboard setting
- [x] Landing page rebuilt as hand-written HTML/CSS/JS in `apps/landing` — no framework, no
      build step. Hero, config-to-feature split, batteries grid, animated benchmark bars,
      comparison table, philosophy, CTA. Starlight now serves docs at `/docs` only
- [x] Brand imagery generated with Gemini (`scripts/generate-assets.mjs`) and optimised to
      WebP (`scripts/optimize-assets.mjs`) — 1.8 MB of PNGs down to 152 KB. OG card text is
      composited as SVG so it stays crisp
- [ ] **"Batteries included" page** — the always-on table from `CLAUDE.md` §2b as a headline feature
- [~] Tutorial, FastAPI-style and progressive. Written: first route, validation (marked
      Planned), errors. Remaining: db, auth, file upload, queue, mail, deploy
- [~] How-to guides. Written: "Coming from Express" (translation, explicitly not a shim),
      benchmarks. Remaining: testing, deployment (Docker/Fly/Railway)
- [~] API reference. Written: `App`, `Context`. Remaining: every other package
- [ ] Docs code samples compiled and tested in CI
- [ ] `examples/minimal` + `examples/kitchen-sink` complete and CI-tested
- [x] Benchmarks page with reproducible methodology, including where we lose
- [ ] Launch: HN, r/bun, Bun Discord, X thread

---

## Backlog / post-1.0

- [ ] 💡 WebSockets + rooms (`Bun.serve` has native WS)
- [ ] 💡 Cache plugin (Redis/memory) with `cached()` helpers
- [ ] 💡 SSE / realtime plugin
- [ ] 💡 Typed RPC client generated from the route table
- [ ] 💡 Admin panel (auto-CRUD from drizzle schema)
- [ ] 💡 OpenTelemetry plugin
- [ ] 💡 i18n plugin
- [ ] 💡 Payments plugin (Stripe)
- [ ] 💡 `oven deploy` to Fly/Railway/Cloudflare Containers
- [ ] 💡 **AOT route compilation.** Elysia is ~2× faster than Oven on dispatch because it
      compiles each route into a specialised function with `new Function` at boot, leaving no
      generic dispatch on the hot path. Adopting this is the only way to close that gap — but
      it is a large change and must wait until the plugin and context contracts stop moving,
      or we will be recompiling the compiler. See `benchmarks/README.md`.

---

## Open questions

- [x] ~~`ctx` as plain object or class with getters?~~ **Class.** Lazy getters need a
      prototype, and a shared hidden class keeps construction to one allocation.
- [ ] Response validation in prod: on or off by default?
- [x] ~~Ship our own logger or wrap pino?~~ **Our own, pluggable.** A small built-in so
      `ctx.log` always works with zero setup; `createApp({ logger })` swaps in pino.
- [ ] Integration test strategy for Postgres/Redis/MinIO — testcontainers or docker-compose in CI?
- [ ] Temp-file spill threshold for uploads — what default? (16MB?)
