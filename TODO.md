# Oven — Task Tracker

**Current state:** **Phases 0–5 complete**, plus the post-1.0 stretch (real-time, cache, CDN
storage, telemetry) and proposal 0001 (response filtering, routers, dependencies). All
**eighteen** packages are published at **0.2.0**, and `theoven.app` is live.

One item is yours: **launch** — and, separately, revoke the npm tokens and the Gemini key that
were pasted in chat during the 0.1.x releases.

```bash
bun create theoven my-app --db sqlite --auth basic
```

Verified end to end against npm, from a cleared cache: create → install → `db:generate` →
`db:migrate` → boot → signup → `/docs`.

Shipped: router, server, context, errors, logger, response coercion, graceful shutdown, the
always-on batteries, middleware, bricks, validation, file-based routing, OpenAPI, the CLI, and
thirteen packages — `db`, `db-drizzle`, `db-mongoose`, `auth`, `auth-basic`, `auth-mongo`,
`auth-clerk`, `auth-better`, `mail`, `storage`, `queue`, plus core and cli.

**1293 tests green**, typecheck and lint clean. Postgres, MongoDB, Redis and MinIO suites are
gated on env vars and run in CI against service containers; CI fails if any of them *skips*, so
a typo in an env name cannot turn a green run into a false one.

Benchmarked against Hono, Fastify and Express at both dispatch and socket level.
Generated OpenAPI documents are validated by a real parser in the test suite. Docs site and
landing page live at theoven.pages.dev; GitHub repo live; `@theoven` npm org claimed.

**Next task:** Phase 5 — release. `create-oven` so `bun create oven` works, the two `examples/`
apps, docs samples compiled in CI, and moving the Cloudflare deploy into GitHub Actions.

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
- [x] **You:** buy `theoven.app` and point it at the Cloudflare Pages project — done, live
- [ ] **You:** rotate the npm token that was pasted into chat — now more urgent, since it can
      publish to `@theoven/*` and those names are live — then add the new one as the
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
- [x] Comparative benchmark vs Hono — see `benchmarks/README.md`. Express excluded on
      purpose: it has no `Request` entry point, so the comparison would not be like-for-like
- [x] Socket-level throughput benchmark with a real load generator, including Express and
      Fastify — `benchmarks/http.bench.ts`. Oven ~5.8x Express, ~1.3x Fastify; Hono is ~3.5%
      ahead of us. Confirms that dispatch-level differences compress at the socket: Hono
      dispatches 1.55x faster than Oven on a static root and is only 4.7% ahead over a socket

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
- [x] Zod integration: `z.file()` validates a real multipart upload end to end, including
      size constraints and a text field sent where a file was declared
- [x] Direct handoff to `@theoven/storage` without a round trip through memory. A multipart
      `File` is already spilled to a temporary file by Bun; `ctx.storage.upload(key, file)` hands
      that straight to `Bun.S3Client.write` or `Bun.write`, both of which stream. Nothing calls
      `arrayBuffer()`. Covered by a route test that uploads a real multipart form.

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
- [x] Directory-scoped `_middleware.ts` — landed with §1.8, outermost first, boundary-safe

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

### 1.7 Errors ✅

Landed with §1.2 and verified here rather than assumed.

- [x] `OvenError` base plus twelve subclasses — `BadRequest` through `ServiceUnavailable`
- [x] RFC 9457 problem+json serialisation, with extension members for validation detail
- [x] Dev vs prod output: internal messages and stacks never reach the client in production,
      asserted by a test that a connection string cannot appear in a 500
- [x] Global `onError` override that cannot mask the original failure when it throws itself
- [x] Redaction tests: neither a bearer token nor a session cookie can reach an error response

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
- [x] Dev reload — `oven dev` runs the app under a watcher and restarts on change. Restart
      rather than in-place patching: see Phase 4 for why correctness beats the milliseconds

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
- [x] `oven openapi` CLI command — landed with Phase 4; stdout by default so it pipes

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

**Every brick below ships with its catalogue page in the same commit** — see `CLAUDE.md` §5b for
the required shape. A brick without a page is not done.

### 2.1 `@theoven/db` — the contract ✅
- [x] `DatabaseProvider<Client>`: `connect`, `health`, `close`, `transaction`
- [x] `ctx.db` is the **native client**, fully typed from the user's own schema (D16)
- [x] Per-request transaction opt-in — shipped as `transactional()` middleware rather than a
      `request()` hook, because a transaction has to *wrap* the handler and `request()` returns
      before it runs. Being middleware also makes the scope explicit, which matters: applied
      globally it holds a transaction open across every slow external call in the app.
- [x] Graceful close wired to `app.close()`

### 2.2 `@theoven/db-drizzle` ✅
- [x] SQLite via `bun:sqlite` (the default), Postgres, MySQL
- [x] Pooling and health check
- [x] `oven db generate | migrate | push | studio | drop` — delegates to the project's own
      migration tool, detected from its config file (`drizzle.config.ts` → drizzle-kit,
      `prisma/schema.prisma` → Prisma CLI), translating names where the two disagree. Replacing the
      stub that currently reports the module is missing
- [x] Tests against real SQLite (`bun:sqlite`, already real), Postgres and MongoDB. The
      Postgres and Mongo suites are gated on `POSTGRES_URL` / `MONGO_URL` and run in CI against
      `postgres:17` and `mongo:8` service containers. CI fails if either suite *skips*, so a
      typo in an env name cannot turn a green run into a false one.

### 2.3 A second db adapter
- [x] `@theoven/db-mongoose` shipped — **the point is that it is structurally
      different from Drizzle.** A contract with one implementation is a guess; the second one
      is what proves it holds, exactly as Valibot proved the validator contract.

      **What it found:** three of the four contract methods fit Mongoose unchanged. `transaction`
      did not — Mongoose scopes a transaction to a *session* attached per query, not to a client
      that can be handed to `work`. The contract did not bend: `transaction` stays optional, the
      provider declares no support, and `transaction()` refuses rather than running unwrapped.
      Faking a session-bound client by proxying every model would have worked for `find` and
      `save` and quietly not for `aggregate`, `bulkWrite` and `watch`.

      Also found: Mongoose 9 cannot be imported under Bun 1.2 at all — its `bson@7` calls
      `node:v8`'s `isBuildingSnapshot`, which Bun has not implemented. Peer range pinned to
      `^8.0.0`, with the reason on the brick page rather than in a lockfile nobody reads.

### 2.4 `@theoven/auth` — contract and flows (D26) ✅
- [x] `identify(ctx) → Identity | null` — the only required method (D19)
- [x] `Identity`: `{ id, email?, name?, image?, raw }` (D17)
- [x] Declared capabilities (`routes`, `signOut`, `refresh`), checked at boot with an error
      naming the brick and the feature
- [x] `auth: true` guard and **named policies** (D18), with policies appearing as named
      security requirements in the OpenAPI document
- [x] `ctx.user` narrowed to non-null inside a guarded route (`NarrowUser`), with a type-level
      test verified to fail when the narrowing is reverted
- [x] **The security-critical half, written once:** argon2id via `Bun.password`, JWT signing and
      verification, single-use hashed reset tokens, refresh rotation
- [x] `AuthStore` — seven methods, shaped for these flows. Not a general ORM abstraction, and
      not something db bricks implement (D16 stands)

### 2.5 `@theoven/auth-basic` — Drizzle storage, the Laravel/Rails property ✅
The reason `oven create` gives you a working signup before you have provisioned anything.

- [x] Signup with name, email, password
- [x] Login issuing a 15-minute access JWT plus a revocable refresh token row (D20)
- [x] `POST /auth/refresh`, `POST /auth/logout` (deletes the refresh row — logout genuinely revokes)
- [x] Change password while signed in; **invalidates every other session**
- [x] Forgot password → single-use, expiring, hashed reset token sent by email
- [x] Passwords hashed with `Bun.password` (argon2id); timing-safe comparisons throughout
- [x] Rate limiting on login, signup and reset, on by default. Login and reset key on **both**
      IP and email: by IP alone a distributed attempt on one account walks through, by email alone
      one host sprays the whole user table. Fixed-window, in memory, per process — enough to blunt
      credential stuffing, not a precise quota, and the brick page says so.
- [x] Drizzle schema and migrations shipped for its own tables
- [x] `@theoven/auth-mongo` shipped — the same flows over Mongoose, which is what proves `AuthStore`

      **What it forced:** the storage-agnostic half of `auth-basic` — every flow, endpoint,
      cookie and rate limit, ~280 lines — moved into `@theoven/auth` as `passwordAuthProvider`.
      Both bricks are now thin: a store, a schema, and a name. Copying that wiring into a second
      brick would have been a fix landing in one and not the other.

      **`AuthStore` fit without changes.** A shared conformance suite ships at
      `@theoven/auth/testing` and both bricks run the same one — verified to fail when the
      empty-filter guard in `deleteRefreshTokens` is removed.

      **Also found:** `mongooseStore` compiled Mongoose models eagerly, so a missing signing
      secret surfaced as a Mongoose crash instead of the sentence saying what to fix. Models are
      now compiled on first use.
      is real rather than a Drizzle interface wearing a disguise (D25)
- [x] Tests covering the attacks, not just the happy path: reset-token reuse, expired tokens,
      user enumeration via login and reset responses, refresh-token rotation

### 2.6 `@theoven/auth-better` and `@theoven/auth-clerk`
- [x] `auth-better` shipped: mounts its own routes, owns sessions — exercises the `routes` capability
- [x] `auth-clerk` shipped: no routes, hosted sign-in, JWT verification — exercises the opposite end
- [x] Both satisfy the same contract with no changes to it. `auth-clerk` mounts nothing and
      declares `routes: false`; `auth-better` forwards every method under the prefix on a
      wildcard and declares `routes: true`. `AuthProvider` did not move.

      `auth-clerk` is built on WebCrypto rather than Clerk's SDK: a framework brick that depends
      on a vendor SDK owns that SDK's release cadence and its whole transitive tree. JWKS fetch,
      cache, rotation-on-unknown-kid (rate limited, or forged kids become a way to make the
      server hammer Clerk's key endpoint), RS256 verify, then issuer/expiry/azp checks. The
      `alg: none` and RSA-key-as-HMAC-secret breaks both have tests, and the signature tests were
      verified to fail when verification is disabled.

### 2.7 Mail, pulled forward from Phase 3
Only as far as `auth-basic` needs it: password reset cannot work without sending mail.

- [x] `console` driver (dev) and `memory` driver (test), so reset flows work with zero config
- [x] One real driver (Resend or SMTP), enabled by setting env values and nothing else
- The remaining drivers, templating and the preview inbox stay in §3.2 — deliberately out of
  scope here, not outstanding

### 2.8 Default stack and scaffold (D21, D24)

**Fixed later, while writing the guided walkthrough:** the scaffold opened *two* database
connections — `client.ts` for `auth-basic` and `db.ts` for the brick — while its own comment
claimed they were "this same client". Against a file that merely wastes a handle; against
`:memory:` they are two separate databases, so a scaffolded project could not be tested in memory
at all. `db.ts` now adopts the connection `client.ts` opened. Three tests, including one that
fails on an import used only in a comment.

**Verified by running it, not by reading it:** scaffolded a project, linked it to the workspace,
ran `oven db generate` (4 tables, auth's three included), `oven db migrate`, started it, signed
up, called a guarded route with the access token, and requested a password reset — the link
printed to the console. Two real gaps turned up doing that and are fixed:

- `src/schema.ts` did not re-export `auth-basic`'s tables, so a clean generate/migrate produced
  a runtime `no such table: auth_users`.
- drizzle-kit's SQLite migrator cannot use `bun:sqlite` — it demands `better-sqlite3` or
  `@libsql/client`. `oven db migrate` now runs in-process through Drizzle's Bun-native migrator,
  so the default stack needs no native module.
- [x] `oven create --db sqlite` scaffolds **Drizzle over `bun:sqlite`**, with a one-line switch to
      Postgres that leaves every query untouched — asserted by a test comparing the two renders
      file by file
- [x] `--auth basic` scaffolds signup, login and reset working out of the box, with
      `auth-basic`'s tables re-exported from `src/schema.ts` so `oven db generate` picks them up
- [x] Mail defaults to the console driver, so password reset works before any provider exists

**Not done in 2.5:** email verification — the column exists and is never set. It is on the
brick's page under Limitations rather than left for someone to discover. (Rate limiting *was*
done; see §2.5 above.)

**Found while building `db-drizzle`:** Drizzle's `bun-sqlite` transaction does **not** roll back
an async failure. `bun:sqlite` is synchronous, so the transaction commits before the rejection
arrives and the write survives. The provider issues `begin`/`commit`/`rollback` itself and
serialises transactions; both behaviours are covered by tests, including one asserting Drizzle's
own method still has the flaw so the difference stays visible.

### 2.9 Agent ergonomics (D22)
- [x] Brick catalogue section at `/docs/bricks/`, with a fixed page shape so a reader — or a
      model — finds the same headings on every brick
- [x] **Writing your own brick** guide at `/docs/guides/writing-a-brick/`
- [x] `llms.txt` and `llms-full.txt` generated from the docs at build time, so they cannot drift.
      `llms.txt` is the index; `llms-full.txt` is every page in full, MDX components stripped and
      doc links absolutised so they resolve out of context. Ordered by sidebar order then title —
      by URL the tutorial reads 3, 1, 2. The build fails if fewer than 20 pages are found, because
      a path change that finds two would still write both files and still pass.
- [x] `AGENTS.md` written by `oven create`: route naming, `defineRoute`, native ORM queries,
      policies, and the things never to do (no Express middleware, no CommonJS). Sections appear
      only for what was actually scaffolded.

**Deliberately not doing:** a unified query API (D16), normalised roles (D17), and a required
sign-in method every adapter must implement (D19). Each was considered and rejected for reasons
recorded in `CLAUDE.md`.

## Phase 3 — Infrastructure modules

### 3.1 `@theoven/storage` (S3)
- [x] Config → `Bun.S3Client` (S3, R2, MinIO, Spaces) — no SDK; the runtime signs its own requests
- [x] `upload`, `download`, `delete`, `exists`, `stat`, `list` (with prefix and paging)
- [x] `presignUpload` / `presignDownload`, and `canPresign` so the gap is visible before it bites
- [x] Streaming + multipart for large files — Bun switches to multipart above `partSize` with no
      separate API to call; `partSize`, `queueSize` and `retry` are exposed for tuning
- [x] Zero-copy handoff from core's file handling (§1.3) — see the note there
- [x] Browser direct-upload helper — `ctx.storage.directUpload(key)` returns a ticket
      (`url`, `method`, `headers`, `key`, `expiresAt`) meant to be returned from a route as JSON.
      A plain object rather than a bare URL because the content type is *signed*: omit the header
      and S3 answers with a signature mismatch that explains nothing.
- [x] Local-disk driver for dev — the app runs with no S3, and the driver is **refused in
      production** unless explicitly allowed, because uploads on a container filesystem vanish on
      the next deploy while the service looks healthy
- [x] Multiple named buckets — `ctx.storage.bucket('avatars')`, resolved from a map built at boot
- [x] Tests against MinIO in CI, gated on `S3_ENDPOINT` and skipped locally with a printed
      notice. CI starts `minio/minio` as a step (a service container cannot be given a `server`
      command) and fails if the suite skips.

### 3.2 `@theoven/mail`
- [x] Drivers: Resend, **SES** (v2 HTTP, SigV4 signed in ~80 lines, verified against AWS's own
      published test vectors), **SMTP** (spoken over `Bun.connect`), `console` (dev), `memory` (test)
- [x] `mail.send({ to, subject, html | text })` and `mail.sendTemplate({ template, props })`.
      Separate methods rather than an overload: a templated message must not carry its own
      subject, and a union would let one through and quietly ignore it.
- [x] Typed templates — `defineTemplate<Props>()`, a **function** rather than a file format.
      A missing prop is a compile error, not `Welcome, undefined`. JSX is supported by rendering
      it yourself: React Email and `Bun.renderToString` both return a string and a template takes
      whatever you return. Bundling a renderer would be a build step and a second templating
      system to learn.
- [x] Dev preview inbox at `/_oven/mail`, bounded ring buffer, development-only by default —
      it serves working password-reset links, so an unauthenticated page in production would be a
      way to take over accounts. HTML bodies render in a sandboxed iframe; everything else is
      escaped, because a preview shows content that came from users.
- [x] Attachments (Blob, bytes or string — never base64 from the caller; encoded at send time so
      a `Bun.file()` attachment is not read until it goes out), inline `cid:` images, cc/bcc,
      reply-to, and arbitrary headers
- [x] Auto-queues when `@theoven/queue` is present. Implemented with a new **optional**
      `dependsOn` form (`'queue?'`) in core, so the decision is made once at boot and is visible
      in the logs, rather than varying by whichever request ran first. Attachments are resolved
      to bytes before queueing — a Blob does not survive being stored, and a `Bun.file()` handle
      is a path the worker may not be able to read.
- [x] Tests, including a **real SMTP server in the test process** so the driver's actual
      conversation is exercised: EHLO parsing, envelope addresses, dot-stuffing, and the refusal
      to send a password over an unencrypted connection

### 3.3 `@theoven/queue`
- [x] Drivers: Redis (sorted sets + a Lua reserve script), Postgres (`FOR UPDATE SKIP LOCKED`),
      in-memory (dev/test, and refused in production)
- [x] `defineJob<Payload>()`; `queue.dispatch(job, payload)` — the definition is passed rather
      than a name, so the payload type is enforced at both ends and a typo is a compile error
- [x] `oven worker --concurrency N --once`. Imports the **app module**, so the worker has the
      same bricks and the same job definitions — a worker configured separately drifts, and the
      symptom is jobs dead-lettering as "no handler registered" after a deploy.

      Needed a new core API: `app.service(name)`, a typed accessor for a brick's contributed
      service outside a request. The gap had already come up once while testing the Postgres
      adapter, and it is what a migration script or a seed needs too.
- [x] Retries with exponential backoff, dead letter with the error that killed the job and a
      `revive()` that resets attempts, and per-job timeouts that abort an `AbortSignal` the
      handler can pass to `fetch`
- [x] Delayed and scheduled jobs (`delay`, `runAt`), plus dedupe keys so fifty writes that each
      want the index rebuilt rebuild it once
- [x] Cron tasks in config — a cron parser written here rather than depended on (~150 lines),
      with the day-of-month/day-of-week OR rule everybody gets wrong. A bad expression, or one
      naming an unregistered job, fails at boot.
- [x] Dev dashboard at `/_oven/queue` — counts, dead letter with causes, upcoming cron runs.
      Everything escaped: a dead job's error message is whatever the failure produced, and some
      of that started as user input.
- [x] Graceful shutdown drains in-flight jobs, then aborts their signal after a grace period
- [x] Tests — all three drivers run the **same** conformance suite from `@theoven/queue/testing`,
      because a queue whose semantics change with its backend is one you can only trust in the
      environment you tested it in. Redis and Postgres are gated on env vars and run in CI.

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
- [x] `bun create theoven my-app` — shipped as `create-theoven`, a thin delegate to
      `oven create` so there is one scaffolder rather than two that drift.

      **Not `bun create oven`:** `create-oven` on npm belongs to someone else (see D27). Bun maps
      `bun create <x>` to `create-<x>`, so the name had to change, not the command shape.

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

### 5.0 npm — done

- [x] All fourteen packages published, in dependency order, with `bun publish`. Now at **0.1.2**:
      0.1.1 added `routesFor`, `drizzleSqlite({ client })` and per-operation OpenAPI security;
      0.1.2 fixed the scaffold shipping `^0.0.0` dependency ranges.
- [x] `create-theoven` published, so `bun create theoven my-app` works. It needed a token that
      can create **unscoped** packages — the original was granular-scoped to `@theoven`, which is
      why the first attempt returned 403 on that one package alone.
- [x] `scripts/check-publish.mjs` packs every package and checks what npm would actually receive:
      no `workspace:` ranges, no test files, README and LICENSE present, every `exports` and `bin`
      target actually in the tarball, and one version across the repo. Runs in CI and before a
      release, and was verified to fail when a package is made to ship its tests.
- [x] `scripts/publish.mjs` replaces `changeset publish` in the release workflow. Changesets
      shells out to **npm**, which does not understand `workspace:` — one leaked `workspace:^` in
      a published `peerDependencies` makes every install fail with `EUNSUPPORTEDPROTOCOL`. The
      script uses `bun publish`, resolves publish order from the dependency graph, and skips
      versions already on the registry so a partial release can simply be re-run.
- [x] Verified by installing from npm into a clean project and running a real app: eight bricks
      compose, signup and an authenticated request work, and `oven --version` reports 0.1.0

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
- [x] Point theoven.app at the Pages project — live, serving the landing page, docs and llms.txt
- [~] Moved to GitHub Actions + Wrangler in `.github/workflows/deploy.yml`: builds on a runner,
      publishes with `wrangler pages deploy`, and only runs when the site or its build scripts
      change. **Needs two secrets from you** — `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
      — before it can run, so `scripts/cloudflare-build.sh` is kept as the fallback path.
- [x] Landing page rebuilt as hand-written HTML/CSS/JS in `apps/landing` — no framework, no
      build step. Hero, config-to-feature split, batteries grid, animated benchmark bars,
      comparison table, philosophy, CTA. Starlight now serves docs at `/docs` only
- [x] Brand imagery generated with Gemini (`scripts/generate-assets.mjs`) and optimised to
      WebP (`scripts/optimize-assets.mjs`) — 1.8 MB of PNGs down to 152 KB. OG card text is
      composited as SVG so it stays crisp
- [x] **"Batteries included" page** at `/docs/start/batteries/` — the §2b table as a headline
      feature rather than an API reference: opens with the five-dependency Express version of an
      upload route, answers "why not middleware", and states that laziness is a test rather than
      a promise. The reference page keeps the per-API detail.
- [x] Tutorial, FastAPI-style and progressive: first route → validation → errors → database →
      auth, explicitly ordered so the sidebar reads as a path rather than alphabetically.
- [x] **Guided project: "Build a todo API"** — six chapters from `bun create` to a deployed,
      authenticated, tested API. Distinct from the tutorial: that teaches one idea per chapter,
      this builds one application end to end.

      Written from a **working app**, not from memory. The application was scaffolded, built,
      exercised over HTTP and tested before a word of it was written; every snippet is copied out
      of code that runs, and the test suite in chapter 5 passes as printed. Building it found a
      real scaffold bug — see §2.8.
- [x] How-to guides: "Coming from Express", benchmarks, **testing** (through `app.fetch`, with
      the memory mail driver and `worker.drain()`), and **deployment** (verified: `oven build`
      emits one `dist/index.js` that runs with no `node_modules` at all, which is what makes the
      two-stage Dockerfile in the guide honest).
- [x] API reference, audited against the actual export surface rather than written from memory:
      `App`, `Context`, file-based routing, **validation**, **errors**, middleware, batteries, env,
      bricks, CLI — plus a page per brick under `/docs/bricks/`.

      `Context` was 280 words for the object every handler receives, and ended with a "Coming in
      Phase 1.3" section listing `ctx.body`, `ctx.query`, `ctx.cookies` and `ctx.token` — all of
      which shipped long ago. It is now 1290 words covering every member. `App` went 499 → 960
      with the full options table. `validation` and `errors` are new. Every claim on those pages
      was executed against the real framework before publishing; four were wrong and are fixed.
- [x] Docs code samples checked in CI (`scripts/check-docs.mjs`), and in the site build. Two
      checks, chosen because they catch real rot without demanding that every snippet be a
      complete compilable module — most are fragments on purpose, and rewriting 135 of them into
      standalone programs would make the pages worse to read in order to make them checkable:

      1. **Every block parses**, as a program or as the fragment it plainly is (object literal,
         bare property, function body), with `...` treated as the placeholder everyone reads it
         as. Verified that genuine syntax errors are still rejected under every fallback.
      2. **Every name imported from `@theoven/*` exists.** This is the rot that matters: renaming
         an export and leaving a page describing the old one turns documentation into a trap.
         Type-only names are read from source, since types are erased at runtime.

      140 samples, 62 imported names. Both failure modes verified by breaking a page on purpose.
- [x] `examples/minimal` + `examples/kitchen-sink` complete and CI-tested. The kitchen sink is
      the framework's **integration test**: every brick in one app, exercised through `fetch`,
      so a change that breaks how two of them compose fails there rather than in someone's
      project.

      **Three real gaps it found**, none of which any unit test could have:

      1. `defineRoute` hardcoded `Ext = unknown`, so a file-based route could not see the bricks
         the app registered — `ctx.db` was `unknown` in the one place most routes are written.
         Core now exports `routesFor<typeof app>()`, bound once per project via a type-only
         import so there is no cycle.
      2. The db brick and `auth-basic` each opened their own connection. Two to a file waste a
         handle; two to `:memory:` are two separate databases, which surfaces as `no such table`
         on a schema you watched being created. `drizzleSqlite({ client })` now adopts an
         existing one, and does not close what it did not open.
      3. OpenAPI never read a route's `auth`, so guarded routes were documented as public
         endpoints that answer 401 — every generated client would omit the credential. Operations
         now carry `security`, a `401`, and for a named policy its name plus a `403` (D18).
- [x] Benchmarks page with reproducible methodology, including where we lose
- [ ] Launch: HN, r/bun, Bun Discord, X thread

---

## Backlog / post-1.0

- [x] ~~💡 WebSockets + rooms~~ **Shipped 0.1.3.** `app.ws()` on an ordinary guarded route, with
      Bun's own pub/sub for rooms.
- [x] ~~💡 Cache brick (Redis/memory) with `cached()` helpers~~ **Shipped 0.1.3** as
      `@theoven/cache`, with tag invalidation and stampede protection.
- [x] ~~💡 SSE / realtime brick~~ **Shipped 0.1.3** in core rather than as a brick — `sse()` is
      a return value, not a capability on the context.
- [x] ~~💡 OpenTelemetry brick~~ **Shipped 0.1.3** as `@theoven/telemetry`.
- [ ] 💡 Typed RPC client generated from the route table
- [ ] 💡 Admin panel (auto-CRUD from drizzle schema)
- [ ] 💡 i18n brick
- [ ] 💡 Payments brick (Stripe)
- [ ] 💡 `oven deploy` to Fly/Railway/Cloudflare Containers
- [ ] 💡 **AOT route compilation.** Compiling each route into a specialised function with
      `new Function` at boot leaves no generic dispatch on the hot path; Oven interprets the same
      structure on every request, and the dispatch table in `benchmarks/README.md` is where that
      cost shows up. It is a large change and must wait until the brick and context contracts
      stop moving, or we will be recompiling the compiler.

      **Note:** this item used to cite a measured ~2× gap against Elysia. Elysia was removed from
      the benchmark suite on request, so that figure is no longer reproducible from this repo —
      the technique is still worth adopting, but the number is gone and should be re-measured
      against whatever we compare to next rather than quoted from memory.

---

## Regressions to chase

- [x] ✅ **Dispatch regression found and mostly fixed.** Bisected by checking out
      `packages/core/src` at each commit and re-running the bench: it appeared in a single step at
      `5a3ae12` ("middleware, lifecycle hooks and the plugin system") and was flat across the ten
      commits after it. It was never a slow drift — the published numbers were taken at `3c03842`,
      *before* middleware landed, and were simply never re-run.

      **The cause.** That commit moved Context construction ahead of routing, so middleware could
      wrap requests that match nothing — CORS preflights, 404s that still need logging and
      headers. Routing then read `ctx.path`, and `ctx.path` was `this.url.pathname`, so every
      request built a `URL` to answer a question a substring already answered: ~580 ns each.

      **Fixed by** scanning the path once in `dispatch` and handing it to the Context, so
      `ctx.path` is a field read; caching `contextInit`, which was a getter rebuilding two objects
      per request; guarding the empty hook/brick loops on `length` so they allocate no iterator;
      and precomputing which bricks actually have an `onRequest`.

      | scenario | before | now | baseline |
      | --- | ---: | ---: | ---: |
      | static root | 1664 ns | **1258 ns** | 1060 ns |
      | param + json | 1931 ns | **1519 ns** | 1337 ns |
      | deep static | 1826 ns | **1423 ns** | 1221 ns |
      | 404 miss | 1910 ns | **1530 ns** | 1278 ns |

      At the socket, Oven went from 3.5% behind Hono to **0.5%** — inside variance.

- [ ] The remaining ~15% over the pre-middleware baseline is the design, not a defect: the Context
      is built before routing, and `runRoute`/`finish` are separate async frames so middleware can
      wrap routing. Closing it means inlining the response path, which duplicates the response-hook
      logic — not worth it for ~80 ns until something measurable depends on it.

- [ ] Re-run benchmarks before launch, on a quiet machine, and check the landing-page figures
      against the result rather than against memory. (All published figures were re-measured
      after the fix: socket the mean of two runs, dispatch the mean of three.)

**Also found:** the Astro docs build was silently depending on `elysia` hoisting `cookie@1.1.1`
to the root. Removing Elysia hoisted express's `cookie@0.7.2` instead — CJS, no named exports —
and the docs build failed on `parseCookie`. `cookie@^2.0.1` is now a direct devDependency so the
resolution is declared rather than a side effect of an unrelated benchmark package. Express keeps
its own nested 0.7.2 and still benchmarks.

## Open questions

- [x] ~~`ctx` as plain object or class with getters?~~ **Class.** Lazy getters need a
      prototype, and a shared hidden class keeps construction to one allocation.
- [x] ~~Response validation in prod: on or off by default?~~ **Split in two (D29).**
      *Serialisation* is on everywhere — a response schema's parsed output becomes the body, so
      it filters undeclared fields, which is a security control. *Validation* — failing the
      request when the value does not parse — stays on in development and off in production,
      because failing closed there turns a drifted schema into an outage. Measured cost: +482ns
      on routes that declare a schema, none on routes that do not.
- [x] ~~Ship our own logger or wrap pino?~~ **Our own, pluggable.** A small built-in so
      `ctx.log` always works with zero setup; `createApp({ logger })` swaps in pino.
- [ ] Integration test strategy for Postgres/Redis/MinIO — testcontainers or docker-compose in CI?
- [ ] Temp-file spill threshold for uploads — what default? (16MB?)

## Next phase — proposal 0003 (draft, awaiting decisions)

[AI, sandboxes, ingest and payments](docs/proposals/0003-ai-sandboxes-ingest-payments.md).

- [ ] **D38** — AI: wrap the Vercel AI SDK rather than write a model adapter per provider. The
      obvious version reimplements something better-maintained that tracks a landscape changing
      weekly; the defensible version is the infrastructure *around* inference.
- [ ] **D39** — Payments: narrow contract (checkout, webhook verification, fetch, refund).
      Subscriptions stay provider-specific — Paddle is a merchant of record and Stripe is not, and
      a contract unifying them would lie to one.
- [ ] **D40** — Sandboxes: isolation is a declared capability; timeouts and resource limits are
      required arguments, not defaults.
- [ ] **D41** — Which "ingest"? RAG document pipeline, or Inngest-style durable workflows. They
      share a name and nothing else.

Also surfaced while drafting: the middleware docs and `middleware.ts` both promise "a Redis-backed
limiter arrives with `@theoven/queue`". It never arrived. `@theoven/ratelimit` is in the proposal
to pay that off.

## Proposal 0002 — done

[Google and GitHub sign-in](docs/proposals/0002-social-login.md) — two optional flows beside the
password flow, no second brick and no breaking migration.

- [x] ~~D33 account linking~~ · ~~D34 verified email required~~ · ~~D35 provider tokens~~ —
      all three decided as recommended, plus **D36** (unusable-password sentinel) which fell out
      of the build.
- [x] **Shipped.** Optional `AuthStore` account methods with boot-time capability checking,
      accounts conformance tests, the sentinel, session/password/oauth endpoint groups, Google and
      GitHub, and storage in both `auth-basic` (Drizzle) and `auth-mongo` (Mongoose).

Still open on this:

- [ ] Apple — deliberately deferred. Its self-signed ES256 client secret, `form_post` callback and
      first-authorisation-only profile are what should stress the provider interface, once there is
      a reason to.
- [ ] An endpoint to link a provider to the **already signed-in** user. Today linking only happens
      as a side effect of signing in, so a password user cannot attach Google from a settings page
      without signing out first. `unlinkAccount` exists and is not yet mounted.
- [ ] Scaffold support: `oven create --auth basic` still writes a password-only app.

## Proposal 0001 — done

[Response serialisation, routers, dependencies](docs/proposals/0001-serialization-routers-di.md)
— the three gaps against FastAPI that matter for larger codebases.

- [x] **D29 — response serialisation.** Option (a): schemas serialise in every environment,
      `serializeResponses` on by default; mismatch is a 500 in development and a logged,
      unfiltered 200 in production. Shipped.
- [x] **D30 — routers.** Shipped. `router()`, `routerFor<typeof app>()`, `app.use(router)`,
      nesting, scoped middleware, remounting. Sub-app mounting explicitly out of scope.
      - [x] ~~Follow-up: migrate first-party bricks onto routers.~~ **Done, and it needed no
            contract change** — `MountRegistrar` is untouched. The adapter still registers one
            path at a time; what changed is that those registrations land in a router the brick
            mounts via the new `context.mount()`. `auth`, `mail` and `queue` endpoints now carry
            tags. Found while doing it: the mail inbox and queue dashboard were appearing in the
            generated OpenAPI document, so `/_oven/*` is now excluded from it.
      - [x] ~~Follow-up: `router.ws()`.~~ **Done.** Sockets carry the router's prefix, tags and
            `auth` — the last mattering most, since a socket that skipped its group's guard is
            the back door `app.ws()` exists to prevent.
- [x] **D31 — dependencies.** Shipped. `dependency()`, `deps` on a route, `ctx.deps.<name>`,
      sub-dependencies, per-request caching, generator teardown, `app.override()`.
      - [x] ~~Follow-up: `router({ deps })`.~~ **Done.** Accumulates with a route's own; the
            route wins a name collision. Typed for the router's own handlers; a nested child
            cannot be typed for its parent's, which is documented rather than papered over.
      - [x] ~~Follow-up: cycle detection.~~ **Done.** `DependencyCycleError` naming the path,
            e.g. `a -> b -> c -> a`. A diamond is not a cycle. The chain is popped when a
            dependency finishes so a later cycle's message describes only the cycle.
      - [x] ~~Follow-up: resolve independent dependencies concurrently.~~ **Done.** Three 10ms
            dependencies went from 33ms to 11ms. Cost: ~400ns on routes declaring more than one.
            Doing it exposed that cycle detection used one shared chain, which conflated
            concurrent branches — replaced with per-branch ancestry.

- [x] ~~**Bug:** a handler returning a `Response` 500s when its route declares a `response`
      schema.~~ **Fixed.** It affected all six documented take-control return types, not just
      `Response`: `ReadableStream`, `Blob`, `Bun.file`, typed arrays and `URL` redirects each
      produced a 500 on a route that was working. `tookControl()` lives beside `toResponse` in
      `response.ts` so the passthrough list cannot drift from the coercion table. Strings are
      deliberately excluded — `z.string()` is a fair contract for a text endpoint. Nine tests,
      each verified to fail before the fix, and the guard checked for over-breadth by forcing it
      true and confirming the drift-detection tests go red.
