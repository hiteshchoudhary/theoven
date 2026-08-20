# @theoven/core

## 0.6.1

### Patch Changes

- Fixes 0.6.0, which was published with `"@theoven/core": "workspace:^"` in `peerDependencies` on
  every package. That is a protocol no installer resolves, so 0.6.0 cannot be installed. Use
  0.6.1; 0.6.0 has been deprecated on npm.
  
  The cause: `changeset publish` shells out to **npm**, and npm does not rewrite Bun's `workspace:`
  protocol — `bun publish` does. `check-publish.mjs` had documented this exact trap in its own
  docstring for months, and still missed it, because it packed with `bun pm pack` while the release
  ran npm. The guard was testing a different code path than the release used.
  
  `bun run release` now runs the guard and then `bun scripts/publish.mjs`, which publishes with
  `bun publish` — one tool for both, so what is checked is what ships.

## 0.6.0

### Minor Changes

- c69c632: Per-request dependencies (D31).
  
  ```ts
  const tenant = dependency('tenant', (ctx) => resolveTenant(ctx.header('host')))
  const member = dependency('member', async (ctx, use) => find(await use(tenant), ctx.user.id))
  
  export default route({ auth: true, deps: { member } }, (ctx) => ctx.deps.member.role)
  ```
  
  Bricks are app-level; this is the per-request, per-route scale that was missing. Dependencies
  compose through a `use` argument, resolve once per request however many others ask for them, and
  reach the handler typed at `ctx.deps.<name>`.
  
  An async generator adds teardown, which is what makes a per-request transaction expressible: the
  request's error is thrown in at the `yield`, so `try`/`catch` distinguishes commit from rollback.
  Guaranteed cleanup goes in `finally` — the same rule as Python's `@contextmanager`.
  
  `app.override(dep, resolver)` replaces one for tests, including where it is used as a
  sub-dependency.
  
  Costs nothing on routes that declare none, and about 590ns on routes that do.
- ef8bb69: Response schemas now **filter the response body** (D29).
  
  A declared `response` schema's parsed output becomes what is sent, in every environment. Zod
  strips keys it does not declare, so a handler returning a database row sends only the fields it
  promised — a `passwordHash` on that row cannot reach the client.
  
  Previously the parsed value was computed and discarded, and validation was off in production, so
  declaring a response schema did nothing there at all.
  
  - `serializeResponses` (new, default `true`) turns filtering off.
  - `validateResponses` now governs only the failure case: a value that does not parse is a `500`
    in development, and in production is logged with `filtered: false` while the request succeeds.
    Failing closed in production would turn a drifted schema into an outage on deploy.
  - Costs ~480ns on routes that declare a response schema, and nothing on routes that do not.
  
  **Breaking if you relied on undeclared fields being sent.** Add them to the schema, or set
  `serializeResponses: false`.
  
  Also fixes: a handler returning a `Response`, `ReadableStream`, `Blob`, `Bun.file`, typed array
  or `URL` returned a `500` when its route declared a response schema. These now bypass both
  validation and serialisation.
- 8589b1e: Router-level dependencies, and bricks that mount routers.
  
  ```ts
  const admin = routerFor<typeof app>({ prefix: '/admin', deps: { currentTenant } })
  admin.get('/usage', (ctx) => report(ctx.deps.currentTenant))
  ```
  
  `router({ deps })` is the equivalent of FastAPI's `APIRouter(dependencies=[...])`. They accumulate
  with a route's own rather than replacing them, and the route wins a name collision. Typed for the
  router's own handlers; a nested child cannot be typed for its parent's, which is documented.
  
  Bricks now build a router and mount it with the new `context.mount()`. `MountRegistrar` is
  unchanged, so third-party auth adapters are unaffected — the registrations they make simply land
  in a router. `auth`, `mail` and `queue` endpoints now carry tags and group together.
  
  **Fix:** `/_oven/*` — the reserved namespace for brick development tooling — is excluded from the
  generated OpenAPI document. The mail preview inbox and queue dashboard were appearing in it, which
  put a brick's internal dev UI into every client generated from the spec. They are still served.
- e59fb64: `router.ws()` and dependency cycle detection.
  
  **Sockets on a router.** A router can hold WebSocket routes, and its `prefix`, `tags` and `auth`
  apply to them:
  
  ```ts
  const rooms = routerFor<typeof app>({ prefix: '/rooms', auth: true })
  rooms.ws('/:id', handlers)
  ```
  
  The `auth` part matters most: a socket endpoint that quietly opted out of its group's guard would
  be exactly the unguarded back door `app.ws()` exists to prevent.
  
  **Cycles.** A dependency that depends on itself now fails with the path — `Dependency cycle:
  a -> b -> c -> a` — as a `DependencyCycleError`, rather than recursing to "Maximum call stack size
  exceeded", which named neither dependency. A diamond is not a cycle.
- 1ae044a: Routers: mountable groups of routes (D30).
  
  ```ts
  const admin = routerFor<typeof app>({ prefix: '/admin', tags: ['admin'], auth: 'staff' })
  admin.get('/users', (ctx) => ctx.db.select().from(users))
  
  app.use(admin)
  ```
  
  `prefix`, `tags` and `auth` are declared once for the group. Tags accumulate with a route's own;
  everything else the route wins — including `auth: false`, so one public route can live inside an
  otherwise guarded group. Routers nest, carry prefix-scoped middleware, and can be mounted more
  than once, which is how versioned APIs and route-shipping packages work.
  
  `routerFor<typeof app>()` binds the app type so `ctx` is typed, the same way `routesFor` does.
  
  **Breaking:** the radix tree previously exported as `Router` is now `RadixRouter`. `Router` names
  the thing you build. Almost nobody imports the radix tree directly; if you do, rename the import.

### Patch Changes

- dee857d: Require Bun 1.4 or newer across every package.
  
  Nothing in core changed; the whole suite passes unchanged on the new runtime. The bump is so
  packages can use APIs that arrived in 1.4 — `Bun.Image` first — rather than feature-detecting
  around them forever, and is cheap to take now while the framework is pre-1.0.
- 50ce9ed: A route's declared dependencies now resolve concurrently.
  
  Three dependencies each doing 10 ms of I/O cost ~11 ms instead of ~33 ms — a route waits for the
  slowest, not the sum. Sub-dependencies are still ordered by what needs what.
  
  A failure is reported in **declaration order** rather than by whichever rejected first, so the same
  bug does not produce different errors on different runs. Siblings are still torn down.
  
  Costs ~400 ns on routes declaring more than one dependency; routes with one are unchanged.
- 313025d: Fix: a route file declaring `export const auth = true` was not guarded.
  
  `auth` was missing from the keys collected off a route module, so the
  declaration never reached the auth brick and the route answered anonymously with
  a `200`. The `defineRoute({ auth: true }, handler)` form was unaffected.
  
  Anyone on 0.1.2 using file-based routing with `export const auth` has unguarded
  routes and should upgrade.
- 313025d: Four new bricks, and the core support they needed.
  
  - `@theoven/cache` — `ctx.cache` with tag invalidation and stampede protection,
    over an in-process LRU or Redis.
  - `@theoven/telemetry` — OpenTelemetry request spans named by route pattern,
    `traceparent` propagation, `span()` and `traceIds()`.
  - `@theoven/storage-bunny`, `@theoven/storage-imagekit` — two more drivers behind
    the storage contract.
  
  Core gains `app.ws()` and `sse()` for real-time, and `ctx.routePattern`.
