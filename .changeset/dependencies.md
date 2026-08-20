---
'@theoven/core': minor
---

Per-request dependencies (D31).

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
