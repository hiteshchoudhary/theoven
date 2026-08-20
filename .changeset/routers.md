---
'@theoven/core': minor
---

Routers: mountable groups of routes (D30).

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
