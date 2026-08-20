# Changelog

Every package is versioned together. Pre-1.0, minor versions may break.

---

## 0.5.1

### Breaking — 56 internal exports removed

`parseBody`, `scanRoutes`, `toResponse`, `parseCron`, `renderInbox`, `captureToken` and about
fifty others are no longer exported from their package indexes.

They were never features — they are the framework's own moving parts, exported at some point so a
test could reach them and left exported afterwards. The tests did not need it either: every one
imports from the module directly, so these were pure public surface. Everything exported is a
promise not to change it, and 149 promises for a framework with about 90 real API entry points is
a tax on every future release.

**If you imported one**, you were reaching into internals. That still works — import from the file
instead:

```ts
import { parseCron } from '@theoven/queue/src/cron'
```

Which is more honest: the import says plainly that you reached past the contract.

Four exports that *looked* internal were kept, because `oven build` writes `readRouteModule` and
`setRouteManifest` into your project's generated files — removing them would have broken every
built application rather than only code that imported them.

### The remaining surface is documented

[The public API](https://theoven.app/docs/reference/public-api/) is a new page: what each package
exports, what is deliberately internal, and — for the nineteen exports that had a real caller but
no documentation — who calls them and why. `signAccessToken` for a token outside the endpoints,
`isUnusablePassword` for a settings page that should say "set a password" rather than "change
password", `assertSafeKey` for anyone writing a storage driver.

---

## 0.5.0

### Sign in with Google and GitHub

```ts
basicAuth({
  db: client,
  secret: env.string('AUTH_SECRET'),
  callbackUrl: (provider) => `${env.string('APP_URL')}/auth/oauth/${provider}/callback`,
  oauth: { google: { provider: google, clientId, clientSecret } },
})
```

Two optional flows beside the password flow. Each configured provider mounts two endpoints and
nothing else, and an OAuth sign-in issues the **same** session a password login does — so
`auth: true`, your policies, logout and sign-out-everywhere keep working untouched.

`password: false` mounts no `signup`, `login` or password-reset endpoints, for an application that
authenticates only through providers. The session endpoints stay.

**Entirely additive.** An app that never configures `oauth` gets no new tables, no new endpoints
and no migration. Users created by a provider are stored with an *unusable* password rather than a
null one, so `auth_users` is untouched.

The rules that matter:

- Linking to an existing user happens **only** when the provider verified the email address. A
  bare email match is an account-takeover path (D33).
- A provider returning no verified email is **refused** rather than creating an account that could
  never be linked or recovered (D34).
- Provider tokens are **not stored** unless you opt in per provider with `storeTokens` (D35).
- Identity is keyed on the provider's subject id, never the email, so changing your address at
  Google does not create a second user.

Adding it takes two steps: add `@theoven/auth-basic/schema/accounts` to your schema, and configure
a provider. Doing one without the other fails at **boot**, naming both fixes.

---

## 0.4.1

### Dependencies resolve concurrently

A route's declared dependencies now start together. Three dependencies each doing 10 ms of I/O
cost **~11 ms instead of ~33 ms** — a route waits for the slowest, not the sum.

A failure is reported in **declaration order**, not by whichever rejected first, so the same bug
does not produce different errors on different runs. Siblings are still torn down: a dependency
that opened a transaction and a sibling that then threw will not leave it open.

Costs ~400 ns on routes declaring more than one dependency; routes with one are unchanged.

Doing this exposed that cycle detection used a single shared chain, which conflated concurrently
resolving branches and attached unrelated dependencies to a reported cycle's path. It now tracks
ancestry per branch.

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
