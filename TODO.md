# Oven — Task Tracker

**Current state:** **Phases 1 and 4 complete.** Router, server, context, errors, logger, response
coercion, graceful shutdown, the always-on batteries, middleware, bricks, validation,
file-based routing, OpenAPI, and the CLI. **850 tests green**, typecheck and lint clean.

Benchmarked against Hono, Elysia, Fastify and Express at both dispatch and socket level.
Generated OpenAPI documents are validated by a real parser in the test suite. Docs site and
landing page live at theoven.pages.dev; GitHub repo live; `@theoven` npm org claimed.
**Next task:** Phase 2.0 — typed per-request brick state in core, which everything else
in Phase 2 depends on.

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
- [x] Works with **no auth module installed**: capture is core, verification is the brick's job
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

### 1.4 Middleware & hooks ✅

`packages/core/src/middleware.ts` — 53 tests.

- [x] Onion-model middleware with `next()`, correct in/out ordering, short-circuit by not
      calling `next()`
- [x] Awaiting `next()` twice throws — it would otherwise run the rest of the chain again, and
      the resulting double-write is very hard to trace back to its cause
- [x] Lifecycle hooks: `onRequest`, `beforeHandle`, `afterHandle`, `onResponse`, `onError`
- [x] Path-scoped middleware (`app.use('/admin', fn)`) respecting segment boundaries, so
      `/admin` never matches `/administrators`
- [x] **Middleware wraps routing, not just the handler.** Found while testing: CORS preflights
      could never work otherwise, because an `OPTIONS` request with no `OPTIONS` route never
      reached middleware. 404s that need security headers and request logs that should include
      misses had the same problem
- [x] Chains composed once per applicable middleware set and cached — keyed by that set rather
      than by path, since paths with parameters are unbounded
- [x] Async errors caught automatically (§1.2)
- [x] Built-ins, configured not installed: CORS, security headers, rate limiting, request
      logging, compression
- [ ] Directory-scoped `_middleware.ts` — belongs with file-based routing in §1.8

**Note:** Bun has no `CompressionStream`, so compression uses `Bun.gzipSync` and deliberately
passes streaming responses through untouched. Buffering a stream to compress it would stop
server-sent events arriving and pull a large download into memory.

### 1.5 Brick system + type inference ✅

`packages/core/src/brick.ts` — 28 tests, including type-level assertions.

- [x] `Brick` interface: `name`, `setup`, `dependsOn`, `onRequest`, `onShutdown`
- [x] `.use()` accumulates brick context types through the chain
- [x] Brick values live on a `Context` **subclass prototype**, so ten bricks cost nothing per
      request; per-request state goes through `onRequest` instead
- [x] Dependency ordering by topological sort; missing dependencies and cycles throw at boot
      naming the bricks involved
- [x] Bricks can contribute their own routes (`/auth/*`, the docs UI)
- [x] `setup()` runs once, is awaited, and is idempotent via `ready()`; `fetch()` boots
      automatically so tests need no explicit call
- [x] Rejected at boot: duplicate names, names colliding with built-in context properties, and
      registration after the first request
- [x] `defineConfig()` / `appFromConfig()` for a declarative config file
- [x] **Type-level tests** proving an unregistered brick is a compile error — and verified that
      those tests actually fail when inference breaks, rather than passing vacuously

**Known limit:** `appFromConfig()` returns a plain `App`. A runtime array of bricks cannot
express each contribution in the type system, so `.use()` chaining stays the typed surface.
Config keys mapping to bricks (`{ storage: {...} }`) needs the module packages to exist.

### 1.6 Validation ✅

`packages/core/src/{standard-schema,validation}.ts` — 48 tests.

- [x] Standard Schema v1 adapter. The contract is declared locally rather than depended on: it
      is type-only, so importing a package to describe it would add a dependency for no runtime
      code
- [x] Validate `params`, `query`, `body`, `headers` → narrowed context types. `ctx.body` becomes
      the value rather than a promise once a schema is declared, since validation already
      awaited it
- [x] **Every location is checked before failing.** Reporting only the first problem turns
      fixing a request into a guessing game, one field per round trip
- [x] `422` problem document with `location`, `path` and `message` per issue; paths render as
      `items[0].qty` so they paste back into client code
- [x] Malformed JSON stays a `400` — the caller sending nonsense is not a shape mismatch
- [x] Response validation: **on in development, off in production**. A mismatch is a `500`, not
      a `422` — the caller did nothing wrong, the route drifted from its contract. Detail shown
      in development, withheld in production
- [x] Non-Zod validator proven end to end (Valibot), including mixing libraries on one route
- [x] Type-level tests, verified to fail when inference breaks

**Decision — no automatic coercion.** The TODO originally called for `string → number/boolean/
date` conversion on path and query values. Implemented instead as explicit `z.coerce.number()`,
because Oven cannot know the intent: coercing `"123"` to `123` before the schema sees it
silently breaks a `z.string()` field that legitimately holds digits — an order number, a zip
code, a phone number. Every Standard Schema library ships coercion of its own, so the framework
guessing adds risk without adding capability.

### 1.7 Errors
- [ ] `OvenError` base + `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `Payload TooLarge`, `UnsupportedMediaType`, `TooManyRequests`, `Internal`
- [ ] RFC 9457 problem+json serialisation
- [ ] Dev vs prod output — stack traces and internal messages never leak in prod
- [ ] Global `onError` override
- [ ] Tests, including a redaction test for tokens/passwords/cookies in error output

### 1.8 File-based routing ✅

`packages/core/src/file-routes.ts` — 58 tests.

- [x] Directory scanner → route table: `[id]`, `[...path]`, `index`, `.get`/`.post`/…
- [x] Route module contract: `default` handler plus `params`/`query`/`body`/`headers`/`response`/
      `summary`/`description`/`tags` — the same keys a programmatic route takes
- [x] `_middleware.ts` cascade, outermost first, respecting segment boundaries
- [x] Underscore-prefixed files and `*.test.ts` are never routes, so helpers and tests can sit
      beside the routes they belong to
- [x] Deterministic ordering — a route conflict must not depend on filesystem walk order
- [x] Errors name the file and the fix: a missing method, an unknown method, a mistyped
      catch-all (`[..path]`), an unmatched bracket, a non-function default export
- [x] Build-time manifest with static imports (`generateManifest`), so production neither scans
      the filesystem at boot nor hides route modules from the bundler
- [ ] Dev hot reload — deferred to `oven dev` in Phase 4, where the process supervisor lives.
      `loadRoutes` already accepts a `cacheBust` option for it

### 1.9 OpenAPI + docs UI ✅

`packages/core/src/openapi.ts` — 57 tests, including validation against a real parser.

- [x] OpenAPI 3.1 generated from the route table and schemas via `z.toJSONSchema`
- [x] Served at `/openapi.json`, Scalar UI at `/docs`, both configurable and both excluded from
      the document they describe
- [x] File uploads documented as `multipart/form-data`, detected by `format: 'binary'`
- [x] `422` documented automatically for any route that validates input
- [x] Security schemes contributed by bricks through `BrickHost.contributeOpenApi()` — the
      mechanism the auth module will use in Phase 2
- [x] Non-Zod schemas documented permissively with a warning naming the vendor, rather than
      wrongly or not at all
- [x] **Generated documents validated by `@readme/openapi-parser` in the test suite**
- [ ] `oven openapi` CLI command — Phase 4

**Two bugs the real parser caught that structural tests missed:**

1. Any route with a path parameter and **no `params` schema** produced `{id}` in the URL
   template with no matching parameter object — invalid OpenAPI, and the common case. Path
   parameters are now derived from the pattern.
2. A document with no paths is rejected by strict validators. The 3.1 spec permits an empty
   `paths` object, so rather than fake compliance the generator warns — a zero-route document
   almost always means the brick was installed before any routes, or `exclude` over-matched.

---

## Phase 2 — Data & auth

Restructured from the original plan: these are **contracts plus adapters**, not one package
each. See `CLAUDE.md` D14–D22. Ordered so each step is usable before the next begins.

### 2.0 Core: typed per-request brick state ✅

- [x] `request()` hook on `Brick`: `setup()` contributes a shared service, `request()`
      contributes per-request state, both flowing into the context type through `.use()`
- [x] Runs after routing (so `ctx.params` is available) and before middleware, the handler and
      validation; throwing rejects the request
- [x] Route metadata reaches bricks at request time, so `auth: 'admin'` can be enforced by a
      brick core knows nothing about. `RouteSchema.auth` is typed `unknown` on purpose — the
      moment core knows the shape, core owns auth and auth stops being replaceable
- [x] Contributions land as own properties, so nothing leaks between requests; apps with no
      contributors skip the work entirely
- [x] Type-level tests, verified to fail when inference breaks

**The inference took three attempts, and the reasons are worth keeping:**

1. `Brick<Name, Value, Request>` as the parameter type does not work. Naming a generic interface
   there fixes its type parameters to their declared defaults during inference, silently
   collapsing the `request()` return type — `ctx.user` typed as `Record<never, never>`.
2. A `const` type parameter fixes literal inference for `name`, but also deep-narrows every
   value inside `setup()`, so `() => ({ count: 0 })` yields `count: 0` rather than `count: number`.
3. What works: the parameter shape written inline, with `Name extends string` for literal
   inference and `Value`/`Request` inferred independently. `onShutdown` still receives the
   value `setup()` produced.

### 2.1 `@theoven/db` — the contract
- [ ] `DatabaseProvider<Client>`: `connect`, `health`, `close`, `transaction`
- [ ] `ctx.db` is the **native client**, fully typed from the user's own schema (D16)
- [ ] Per-request transaction opt-in via the `request()` hook
- [ ] Graceful close wired to `app.close()`

### 2.2 `@theoven/db-drizzle`
- [ ] SQLite via `bun:sqlite` (the default), Postgres, MySQL
- [ ] Pooling and health check
- [ ] `oven db generate | migrate | push | studio` — drizzle-kit passthrough, replacing the
      stub that currently reports the module is missing
- [ ] Tests against real SQLite and Postgres

### 2.3 A second db adapter
- [ ] `@theoven/db-prisma` or `@theoven/db-mongoose` — **the point is that it is structurally
      different from Drizzle.** A contract with one implementation is a guess; the second one
      is what proves it holds, exactly as Valibot proved the validator contract

### 2.4 `@theoven/auth` — contract and flows (D26)
- [ ] `identify(ctx) → Identity | null` — the only required method (D19)
- [ ] `Identity`: `{ id, email?, name?, image?, raw }` (D17)
- [ ] Declared capabilities (`routes`, `signOut`, `refresh`), checked at boot with an error
      naming the brick and the feature
- [ ] `auth: true` guard and **named policies** (D18), with policies appearing as named
      security requirements in the OpenAPI document
- [ ] `ctx.user` narrowed to non-null inside a guarded route
- [ ] **The security-critical half, written once:** argon2id via `Bun.password`, JWT signing and
      verification, single-use hashed reset tokens, refresh rotation
- [ ] `AuthStore` — seven methods, shaped for these flows. Not a general ORM abstraction, and
      not something db bricks implement (D16 stands)

### 2.5 `@theoven/auth-basic` — Drizzle storage, the Laravel/Rails property
The reason `oven create` gives you a working signup before you have provisioned anything.

- [ ] Signup with name, email, password
- [ ] Login issuing a 15-minute access JWT plus a revocable refresh token row (D20)
- [ ] `POST /auth/refresh`, `POST /auth/logout` (deletes the refresh row — logout genuinely revokes)
- [ ] Change password while signed in; **invalidates every other session**
- [ ] Forgot password → single-use, expiring, hashed reset token sent by email
- [ ] Passwords hashed with `Bun.password` (argon2id); timing-safe comparisons throughout
- [ ] Rate limiting on login, signup and reset, since these are the endpoints that get attacked
- [ ] Drizzle schema and migrations shipped for its own tables
- [ ] `@theoven/auth-mongo` — the same flows over Mongoose, which is what proves `AuthStore`
      is real rather than a Drizzle interface wearing a disguise (D25)
- [ ] Tests covering the attacks, not just the happy path: reset-token reuse, expired tokens,
      user enumeration via login and reset responses, refresh-token rotation

### 2.6 `@theoven/auth-better` and `@theoven/auth-clerk`
- [ ] `auth-better`: mounts its own routes, owns sessions — exercises the `routes` capability
- [ ] `auth-clerk`: no routes, hosted sign-in, JWT verification — exercises the opposite end
- [ ] Both must satisfy the same contract with no changes to it

### 2.7 Mail, pulled forward from Phase 3
Only as far as `auth-basic` needs it: password reset cannot work without sending mail.

- [ ] `console` driver (dev) and `memory` driver (test), so reset flows work with zero config
- [ ] One real driver (Resend or SMTP), enabled by setting env values and nothing else
- [ ] The remaining drivers, templating and the preview inbox stay in §3.2

### 2.8 Default stack and scaffold (D21, D24)
- [ ] `oven create` defaults to **Drizzle over `bun:sqlite`**, with a one-line switch to Postgres
      that leaves every query untouched
- [ ] Optional `--auth basic` scaffolds signup, login and reset working out of the box
- [ ] Mail defaults to the console driver, so password reset works before any provider exists

### 2.9 Agent ergonomics (D22)
- [ ] `llms.txt` and `llms-full.txt` generated from the docs at build time, so they cannot drift
- [ ] `AGENTS.md` written by `oven create`: route naming, `defineRoute`, native ORM queries,
      policies, and the things never to do (no Express middleware, no CommonJS)

**Deliberately not doing:** a unified query API (D16), normalised roles (D17), and a required
sign-in method every adapter must implement (D19). Each was considered and rejected for reasons
recorded in `CLAUDE.md`.

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

## Phase 4 — CLI & DX (`@theoven/cli`) ✅

`packages/cli/` — 68 tests, plus a clean scaffold-to-running-build check.

- [x] `oven create <name>` — interactive on a TTY, flag-driven otherwise, so it cannot hang in
      CI. Refuses a non-empty directory; tolerates one holding only `.git`
- [x] Templates: `minimal` and `api`. Held as strings rather than files, so a published package
      does not ship scaffolding that type checkers and linters try to compile
- [x] `oven dev` — watcher-based restart with signal forwarding, so Ctrl-C reaches the app and
      graceful shutdown actually runs
- [x] `oven build` — route manifest plus `Bun.build`, in that order
- [x] `oven start` — runs the build, or the source with a note when there is no build
- [x] `oven routes` — prints the route table
- [x] `oven openapi` — stdout by default so it pipes into a client generator; `--out` writes a file
- [x] `oven doctor` — Bun version, entry, app module, routes, env files, port. Every non-ok
      check says what to do about it
- [x] Typed env loading via `defineEnv` in core, reporting every problem at once
- [x] `env.*` reader for single variables — `port`, `bool`, `int`, `url`, `list`, `oneOf`,
      `duration`, `bytes` — parsing that throws rather than guessing. `Boolean('false')` is
      `true`, `Number('')` is `0`, and `parseInt('12abc')` is `12`; all three produce a service
      that starts, looks healthy, and behaves wrongly
- [x] Secret-looking values redacted in `env.all()` **and** in error messages. The variable is
      always named; the value appears only when safe
- [x] No dotenv shipped — Bun already loads `.env`, `.env.local` and `.env.<NODE_ENV>` with the
      right precedence, and a second implementation that disagrees slightly would be worse than
      none
- [x] The scaffold catches `EnvError` in `src/env.ts` and prints it alone. Bun renders an
      uncaught throw with source context from inside the library, which buries the one line
      naming the variable. Setting `error.stack` does not suppress that — tried, reverted, since
      shipping code that claims an effect it does not have is worse than the rough edge
- [x] `oven db` / `oven worker` report that they need an unbuilt module, rather than looking
      like a typo the user made
- [ ] `bun create oven` — needs a published `create-oven` package; Phase 5, at release

**Two design decisions worth recording:**

1. **`app.ts` and `index.ts` are separate in the scaffold.** `app.ts` builds and exports the app;
   `index.ts` calls `listen()`. `oven routes` and `oven openapi` import the former — if they
   imported the entry, asking for a route table would bind a port.
2. **`oven dev` restarts rather than hot-patching.** In-place module reloading leaves a server
   bound to the port and brick state half-initialised. A clean restart takes single-digit
   milliseconds in Bun, and correctness is worth more than the milliseconds.

**A bug found by running the output, not by a test:** `oven build` wrote a route manifest that
nothing imported, so the bundle still tried to scan `dist/routes` and died with `ENOENT`. The
build now generates an entry that installs the manifest before the app module runs, and
`loadRoutes` uses it instead of the filesystem — which keeps the app's own code identical in
development and production. Covered by tests now.

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
- [ ] 💡 Cache brick (Redis/memory) with `cached()` helpers
- [ ] 💡 SSE / realtime brick
- [ ] 💡 Typed RPC client generated from the route table
- [ ] 💡 Admin panel (auto-CRUD from drizzle schema)
- [ ] 💡 OpenTelemetry brick
- [ ] 💡 i18n brick
- [ ] 💡 Payments brick (Stripe)
- [ ] 💡 `oven deploy` to Fly/Railway/Cloudflare Containers
- [ ] 💡 **AOT route compilation.** Elysia is ~2× faster than Oven on dispatch because it
      compiles each route into a specialised function with `new Function` at boot, leaving no
      generic dispatch on the hot path. Adopting this is the only way to close that gap — but
      it is a large change and must wait until the brick and context contracts stop moving,
      or we will be recompiling the compiler. See `benchmarks/README.md`.

---

## Open questions

- [x] ~~`ctx` as plain object or class with getters?~~ **Class.** Lazy getters need a
      prototype, and a shared hidden class keeps construction to one allocation.
- [x] ~~Response validation in prod: on or off by default?~~ **Off.** It validates our own
      code, not untrusted input, and costs a check on every success. Opt in with
      `validateResponses: true`.
- [x] ~~Ship our own logger or wrap pino?~~ **Our own, pluggable.** A small built-in so
      `ctx.log` always works with zero setup; `createApp({ logger })` swaps in pino.
- [ ] Integration test strategy for Postgres/Redis/MinIO — testcontainers or docker-compose in CI?
- [ ] Temp-file spill threshold for uploads — what default? (16MB?)
