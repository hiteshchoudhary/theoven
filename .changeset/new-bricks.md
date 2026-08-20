---
'@theoven/cache': patch
'@theoven/telemetry': patch
'@theoven/storage-bunny': patch
'@theoven/storage-imagekit': patch
'@theoven/core': patch
---

Four new bricks, and the core support they needed.

- `@theoven/cache` — `ctx.cache` with tag invalidation and stampede protection,
  over an in-process LRU or Redis.
- `@theoven/telemetry` — OpenTelemetry request spans named by route pattern,
  `traceparent` propagation, `span()` and `traceIds()`.
- `@theoven/storage-bunny`, `@theoven/storage-imagekit` — two more drivers behind
  the storage contract.

Core gains `app.ws()` and `sse()` for real-time, and `ctx.routePattern`.
