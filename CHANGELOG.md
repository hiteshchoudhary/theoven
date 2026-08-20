# Changelog

Every package is versioned together. Pre-1.0, minor versions may break.

---

## 0.4.0

### WebSocket routes on a router

```ts
const rooms = routerFor<typeof app>({ prefix: '/rooms', auth: true })
rooms.ws('/:id', { params: z.object({ id: z.uuid() }) }, handlers)
```

The router's `prefix`, `tags` and `auth` apply. The last is the point: a socket endpoint that
quietly opted out of its group's guard would be exactly the unguarded back door `app.ws()` exists
to prevent, so a router declaring `auth` guards its sockets too.

### Dependency cycles are named

A dependency that depends on itself, directly or through others, now fails with the path:

```
Dependency cycle: account -> plan -> account.
```

It is a `DependencyCycleError`, so an application can tell a configuration mistake from a resolver
that threw. Previously this recursed until the stack ran out and reported "Maximum call stack size
exceeded", which names neither dependency.

A diamond — two dependencies sharing a third — is not a cycle, and resolves the shared one once.

---

## 0.3.1

### Fixed — every package declared a peer range for the wrong version

`@theoven/mail@0.3.0` declared `peerDependencies: { "@theoven/core": "^0.1.2" }`, which **excludes
the core it shipped beside**. Every dependent package had the same, going back to 0.1.3 — so
installing produced a peer-dependency warning, and a strict resolver could refuse outright.

`bun pm pack` rewrites `workspace:^` using the **lockfile's** recorded version rather than the
manifest's. Versions were being bumped by editing `package.json` without re-running `bun install`,
leaving the lock pinned at 0.1.2 and every published range with it.

Nothing about 0.3.0's code changed. If you installed anything at 0.1.3–0.3.0 and saw a peer
warning, this is it — upgrade to 0.3.1.

`check-publish` now compares each shipped `@theoven/*` range against the version being published
and refuses if they disagree, so a stale lockfile cannot ship again.

---

## 0.3.0

### Router-level dependencies

```ts
const admin = routerFor<typeof app>({ prefix: '/admin', deps: { currentTenant } })
admin.get('/usage', (ctx) => report(ctx.deps.currentTenant))
```

The equivalent of FastAPI's `APIRouter(dependencies=[...])`. They **accumulate** with a route's
own rather than replacing them; the route wins a name collision. A router dependency that throws
refuses every route under it, which makes it a compact group guard.

Typed for the router's own handlers. A nested child is built before it is nested, so it cannot be
typed for its parent's — the dependency still resolves; declare it on the child too if you want
the types.

### Bricks mount routers

`auth`, `mail` and `queue` endpoints now carry tags and group together, via a new
`context.mount()` on the brick setup context.

`MountRegistrar` is **unchanged** — third-party auth adapters are unaffected. They still register
one path at a time; those registrations now land in a router the brick mounts.

### Breaking — `/_oven/*` is out of the OpenAPI document

The mail preview inbox and the queue dashboard were being published in the generated document,
which put a brick's internal development UI into every client generated from it. `/_oven/*` is now
a reserved namespace, excluded from the document. **The endpoints are still served.**

Only breaking if you generated a client against those paths.

---

## 0.2.0

### Breaking — response schemas filter the body

A declared `response` schema's **parsed output is now what gets sent**. Zod strips keys it does not
declare, so a handler returning a database row sends only the fields it promised.

Previously the parsed value was computed and discarded, and validation defaulted off in
production — so declaring a response schema did nothing in the environment where leaking a column
costs something.

**If you relied on undeclared fields being sent**, add them to the schema or set
`serializeResponses: false`.

Two settings, separated because they answer different questions:

| | |
| --- | --- |
| `serializeResponses` (new, default `true`) | does the schema shape the body |
| `validateResponses` (default: development) | does a value that fails to parse fail the request |

A mismatch is a `500` in development. In production it is logged with `filtered: false` and the
request succeeds — failing closed there would turn a drifted schema into an outage on the deploy
that introduced it. Costs ~480 ns on routes that declare a schema, nothing on routes that do not.

### Breaking — `Router` is now `RadixRouter`

The radix tree previously exported as `Router` is `RadixRouter`. `Router` names the route group you
build. Rename the import if you were using the tree directly; almost nobody was.

### Routers

```ts
const admin = routerFor<typeof app>({ prefix: '/admin', tags: ['admin'], auth: 'staff' })
admin.get('/users', (ctx) => ctx.db.select().from(users))
app.use(admin)
```

`prefix`, `tags` and `auth` declared once for a group. Tags accumulate with a route's own;
everything else the route wins — including `auth: false`, so one public route can live inside an
otherwise guarded group. Routers nest, carry prefix-scoped middleware, and can be mounted more than
once.

### Per-request dependencies

```ts
const tenant = dependency('tenant', (ctx) => resolveTenant(ctx.header('host')))
const member = dependency('member', async (ctx, use) => find(await use(tenant), ctx.user.id))

export default route({ auth: true, deps: { member } }, (ctx) => ctx.deps.member.role)
```

Bricks are app-level; this is the per-request, per-route scale. Dependencies compose through a
`use` argument, resolve once per request however many others ask for them, and arrive typed at
`ctx.deps.<name>`.

An async generator adds teardown — the request's error is thrown in at the `yield`, so `try`/`catch`
distinguishes commit from rollback. **Guaranteed cleanup goes in `finally`**, the same rule as
Python's `@contextmanager`: statements after `yield` are skipped when an exception arrives there.

`app.override(dep, resolver)` replaces one for tests, including where it is used as a
sub-dependency. Costs nothing on routes that declare none, ~590 ns on routes that do.

### Fixed — a handler that takes control of the response

A route declaring a `response` schema returned `500` when its handler returned a `Response`,
`ReadableStream`, `Blob`, `Bun.file`, a typed array or a `URL`. All six now bypass validation and
serialisation: a schema describes the JSON body, not a stream.

---

## 0.1.3

### Fixed — file-routed `export const auth` was ignored

**A route file declaring `export const auth = true` was not guarded.** The declaration was dropped
on the way to the auth brick and the route answered anonymously with a `200`.
`defineRoute({ auth: true }, handler)` was unaffected, so this failed totally for anyone following
the file-routing convention and not at all for anyone using the other form.

**Anyone on 0.1.2 using file-based routing with `export const auth` should upgrade.**

### New packages

| | |
| --- | --- |
| `@theoven/cache` | `ctx.cache` — tag invalidation and stampede protection, memory or Redis |
| `@theoven/telemetry` | OpenTelemetry request spans named by route pattern |
| `@theoven/storage-bunny` | Bunny.net behind the storage contract |
| `@theoven/storage-imagekit` | ImageKit, plus transformation URLs |

### Real-time in core

`app.ws()` registers an ordinary route that happens to upgrade, so `auth: true` and `params` are
checked **before** a socket exists — a separate socket entry point is how an endpoint ends up
unguarded. `sse()` covers the one-way case. Adds `ctx.routePattern`.

---

## 0.1.2 and earlier

Initial releases: core, the CLI, the scaffolder, and eleven bricks — database (Drizzle, Mongoose),
auth (email/password on SQL or Mongo, Clerk, better-auth), storage, mail and queues.
