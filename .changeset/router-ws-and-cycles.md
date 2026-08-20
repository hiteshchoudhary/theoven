---
'@theoven/core': minor
---

`router.ws()` and dependency cycle detection.

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
