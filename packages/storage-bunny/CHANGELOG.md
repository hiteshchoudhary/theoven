# @theoven/storage-bunny

## 0.5.3

### Patch Changes

- 313025d: Four new bricks, and the core support they needed.
  
  - `@theoven/cache` — `ctx.cache` with tag invalidation and stampede protection,
    over an in-process LRU or Redis.
  - `@theoven/telemetry` — OpenTelemetry request spans named by route pattern,
    `traceparent` propagation, `span()` and `traceIds()`.
  - `@theoven/storage-bunny`, `@theoven/storage-imagekit` — two more drivers behind
    the storage contract.
  
  Core gains `app.ws()` and `sse()` for real-time, and `ctx.routePattern`.
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
  - @theoven/storage@0.5.3
