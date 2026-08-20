---
'@theoven/core': patch
---

Fix: a route file declaring `export const auth = true` was not guarded.

`auth` was missing from the keys collected off a route module, so the
declaration never reached the auth brick and the route answered anonymously with
a `200`. The `defineRoute({ auth: true }, handler)` form was unaffected.

Anyone on 0.1.2 using file-based routing with `export const auth` has unguarded
routes and should upgrade.
