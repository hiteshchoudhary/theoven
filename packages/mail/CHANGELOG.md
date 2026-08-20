# @theoven/mail

## 0.5.3

### Patch Changes

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
- Updated dependencies [dee857d]
- Updated dependencies [50ce9ed]
- Updated dependencies [c69c632]
- Updated dependencies [313025d]
- Updated dependencies [313025d]
- Updated dependencies [ef8bb69]
- Updated dependencies [8589b1e]
- Updated dependencies [e59fb64]
- Updated dependencies [1ae044a]
  - @theoven/core@0.6.0
