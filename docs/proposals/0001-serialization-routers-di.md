# Proposal 0001 — Response serialisation, routers, and per-request dependencies

Status: **D29 and D30 shipped; D31 awaiting a decision**
Context: the three places Oven is behind FastAPI that matter for large codebases.

Everything here is verified against the code at `313025d`, not recalled. Where a claim was
tested, the test is named.

---

## Summary

| | What it closes | Size | Risk | Order |
| --- | --- | --- | --- | --- |
| **1. Response serialisation** | output filtering — a real data-leak vector | S | medium (behaviour change) | **done (D29, option a)** |
| **2. Routers** | reusable, composable route groups | M | low | **done (D30)** |
| **3. Dependencies** | per-request, per-route, composable injection | L | medium (new concept) | third |

They are independent. Serialisation is worth doing on its own and immediately; DI is the large
one and benefits from routers landing first.

---

## 1. Response serialisation

### What is true today

A `response` schema **only validates, and only in development.** `validateResponses` defaults to
`options.development ?? NODE_ENV !== 'production'`. In production, declaring a response schema
does *nothing at all*.

The consequence is a data-leak vector. This is not hypothetical — the parsed output that would
have prevented it is computed and then discarded:

```ts
// validation.ts — `check()` returns the parsed value. validateResponse throws it away.
await check(responseSchema, value, 'response', issues)
return issues
```

Measured, with Zod's actual output:

```
input   { id, email, passwordHash: '$argon2id$SECRET', note }
parsed  { id, email }              ← the hash is already gone
```

Zod strips unknown keys from `z.object` by default, so **filtering is one line: use the return
value.** The work is not the mechanism, it is deciding the policy.

### A prerequisite bug — **fixed**

A handler returning a `Response` — a documented, supported return type — **500s today** when the
route declares a response schema, because the `Response` object is validated against the schema:

```
GET /x  ->  500  "Response validation failed."
```

Reproduced on `313025d`, and it affected **all six** take-control return types, not only
`Response` — `ReadableStream`, `Blob`, `Bun.file`, typed arrays and `URL` redirects too.

Fixed: `tookControl()` in `response.ts`, beside `toResponse` so the passthrough list cannot drift
from the coercion table it mirrors. Strings stay validated, since `z.string()` is a fair contract
for a text endpoint. The serialisation work below inherits the same guard.

### The change

1. `validateResponse` returns `{ issues, value }`.
2. When there are no issues, the **parsed value becomes the response body**.
3. Skip entirely for the passthrough types above.

### The decision this needs

TODO.md already records this as settled:

> **Response validation in prod: on or off by default? — Off.** It validates our own code, not
> untrusted input, and costs a check on every success.

That reasoning is sound *for validation* and does not cover *serialisation*. The new argument is
that filtering is a **security** control, not a correctness check: it is the difference between
"we notice a drifted contract in dev" and "we cannot leak a column we forgot to omit". FastAPI
made the opposite call and filters always.

Three options:

- **(a) Serialise whenever a response schema is declared, in every environment.** Filtering
  becomes real. Declaring the schema is the opt-in, which is what a reader already expects it to
  mean. Cost: one parse per response *on routes that declared one*. Routes that did not declare a
  schema are untouched, so this respects "lazy, not eager".
- **(b) Serialise in production only behind `serializeResponses: true`.** No surprises, and the
  safety property is off by default — which means off in most apps, which means it is not really
  a safety property.
- **(c) Leave it.** Response schemas stay documentation-and-dev-check only. Then the docs should
  say plainly that a response schema does not prevent leaking fields, because right now a reader
  reasonably assumes it does.

**Decided: (a)** (D29), with the mismatch behaviour split so the change cannot cause an outage:

| | development | production |
| --- | --- | --- |
| parse succeeds | send filtered value | send filtered value |
| parse fails | `500`, with the issues in the body | log `error`, **send the unfiltered value**, do not fail the request |

Failing closed in production would turn a schema that has drifted into a live outage on deploy.
Failing open, loudly, keeps the endpoint working and puts the drift in the logs where it belongs.
This is a deliberate asymmetry and needs to be written down, because it means a *failing* schema
does not filter — so the log line must say so in those words.

### Work

- `validation.ts` — return the value alongside issues
- `app.ts` — use it; skip the passthrough types
- tests — the leak case (`passwordHash` absent from the body); `Response`/stream/`Blob`/`Bun.file`
  passthrough; a failing schema in production still answering `200`; non-object bodies
- docs — `reference/validation`, `tutorial/errors`, and the response-schema mentions in the brick pages
- **new locked decision** in CLAUDE.md, and TODO.md's answered question amended rather than
  contradicted

### Explicit non-goals

`response_model_exclude_unset`, `by_alias`, and per-field serialisation control. Zod's output is
the model; a second serialisation vocabulary on top of it would be inventing.

---

## 2. Routers

### What is missing

There is no way to group routes. `app.use(prefix, middleware)` scopes *middleware* by prefix, and
file routing groups by *directory*, but there is no reusable, mountable unit. Concretely, today
you cannot:

- apply `auth: 'admin'` or a tag to a group of routes in one place
- publish a package that ships routes (a brick registers them one at a time via `context.route`)
- mount the same routes twice under different prefixes

### Design

```ts
import { routerFor } from '@theoven/core'
import type { app } from './app'

const admin = routerFor<typeof app>({ prefix: '/admin', tags: ['admin'], auth: 'admin' })

admin.get('/users', { query: listQuery }, (ctx) => ctx.db.select().from(users))
admin.delete('/users/:id', { params: idParam }, (ctx) => remove(ctx.params.id))

app.use(admin)
```

- A `Router` collects `RouteDefinition`s. It has the same `.get/.post/.put/.patch/.delete/.ws`
  surface as `App` and no lifecycle of its own.
- `app.use(router)` registers them, concatenating `prefix` and merging defaults.
- **Merge rules:** `prefix` concatenates; `tags` concatenate; `auth` and everything else — the
  route wins over the router's default, because the specific declaration is the one in front of
  the reader.
- `router.use(otherRouter)` nests.
- Typing mirrors `routesFor` (D28) for the same reason: a router in its own module cannot see
  which bricks the app registered, so the app type is bound explicitly with a type-only import.

Bricks that mount routes should be migrated to build a router instead of calling `context.route`
per path — one mechanism, and it makes a brick's routes inspectable before registration.

### Non-goal

Mounting a whole second `App` — separate bricks, separate lifecycle, separate shutdown. That is a
much larger feature with real semantics to settle (whose middleware runs? whose error handler?)
and it is not what "I want to group my admin routes" needs. Say so on the page rather than
leaving it implied.

### Work

`router.ts`; an `App.use` overload; migrate `auth`/`mail`/`queue` route mounting; `oven routes`
should show the router a route came from; tests; a `reference/routers` page.

---

## 3. Per-request dependencies

### The gap

Bricks are **app-level**: one instance, built at boot, present on every request. There is nothing
that is per-request, per-route and composable. FastAPI's `Depends()` is its defining feature and
covers exactly that.

The workarounds today are both bad: put it in a brick and it runs for every route in the app, or
repeat it at the top of every handler.

### Design

```ts
import { dependency } from '@theoven/core'

const tenant = dependency('tenant', async (ctx) => resolveTenant(ctx.header('host')))

const member = dependency('member', async (ctx, use) => {
  const t = await use(tenant)          // sub-dependency, resolved once per request
  const m = await findMember(t.id, ctx.user.id)
  if (!m) throw new Forbidden('Not a member of this tenant.')
  return m
})

export default route({ auth: true, deps: { member } }, (ctx) => ctx.deps.member.role)
//                                                              ^ typed
```

**Teardown** uses an async generator, which is how a per-request transaction becomes expressible:

```ts
const tx = dependency('tx', async function* (ctx) {
  const handle = await begin(ctx.db)
  try {
    yield handle
  } finally {
    await handle.commit()
  }
})
```

**Resolution order.** After validation, before the handler. Dependencies routinely need validated
`ctx.params` and `ctx.body`, and auth has already run in the brick `request()` hook, so the
common "is this person allowed" case is upstream either way. The exception — a dependency that
should gate expensive body validation — is real but rarer, and can wait for evidence rather than
a speculative second hook.

**Caching** is per request, keyed by dependency identity, so a dependency named by three routes
in one request resolves once.

**Teardown** runs in reverse order after the response is produced, including when the handler
threw.

**Overrides** are the testing story FastAPI's `dependency_overrides` provides:

```ts
app.override(tenant, () => ({ id: 'test-tenant' }))
```

**Cost when unused is zero** — the same guard the brick contributors already use
(`if (this.contributors.length > 0)`).

### The boundary that needs writing down

Bricks and dependencies will look similar enough to confuse people:

| | Brick | Dependency |
| --- | --- | --- |
| Lifetime | app | request |
| Scope | every route | the routes that name it |
| Setup cost | once, at boot | per request, cached within it |
| Teardown | `onShutdown` | generator `finally` |
| Contributes | `ctx.<name>` | `ctx.deps.<name>` |
| Use for | a pool, a client, a service | a tenant, a permission, a transaction |

`ctx.deps.x` rather than `ctx.x` is deliberate: it keeps the two namespaces from colliding, and
it makes "where did this come from" answerable by looking at the route.

### Open questions

- **`deps` vs a different key.** `deps` is short and matches the mental model; `use` collides
  with `app.use`; `provide` reads backwards at the call site.
- **Generator teardown vs an explicit `dispose`.** The generator is FastAPI's shape and reads
  well, but async generators in a hot path need measuring before committing.
- **Should routers carry `deps`?** FastAPI's `APIRouter(dependencies=[...])` is widely used for
  "everything under /admin needs this". Worth having, and it is the argument for landing routers
  before DI.

### Work

`dependency.ts` (identity, resolver, generator support); extend `RouteSchema` and
`ValidatedContext` so `ctx.deps` types; a resolver + cache + teardown stack in the request
pipeline; an override registry; `oven routes` showing each route's dependencies; tests including
the cache (resolved once) and teardown-on-throw; a `reference/dependencies` page and a section on
the bricks page explaining the boundary.

---

## What this still does not close

Being honest about the remaining distance to FastAPI after all three land:

- **OAuth2 scopes** — no scope model anywhere in `@theoven/auth`
- **Static file serving** — nothing; no `StaticFiles` equivalent
- **Templates** — nothing, and probably correct for an API framework
- **Per-exception-type handlers** — one global `onError`
- **OpenAPI metadata** — no `operationId`, `deprecated`, `include_in_schema`, per-parameter
  `alias`/`examples`, callbacks or webhooks; one docs UI rather than Swagger + ReDoc
- **Simple background tasks** — the queue brick is heavier than FastAPI's `BackgroundTasks`

None of these are composition problems, which is why they are not in this proposal.

---

## Decisions to lock

| | Question |
| --- | --- |
| **D29** | Response schemas serialise. Which of (a)/(b)/(c), and the dev/prod asymmetry on mismatch. |
| **D30** | Routers as the single route-grouping primitive, including for bricks. Sub-app mounting is out of scope. |
| **D31** | Dependencies are per-request and per-route; bricks stay app-level. `ctx.deps.<name>`. |
