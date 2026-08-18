# Benchmarks

Run them yourself — numbers nobody can reproduce are marketing, not measurement.

```bash
bun benchmarks/router.bench.ts     # router lookup in isolation
bun benchmarks/dispatch.bench.ts   # Request -> Response, vs Hono and Elysia
```

Recorded on Bun 1.2.23, Apple Silicon, 2026-08-19. Your absolute numbers will differ; the
ratios are the interesting part.

## Router lookup (`router.bench.ts`)

| scenario | ns/op | ops/s |
|---|---|---|
| static, root | 28 | 36.3 M |
| static, 1 segment | 84 | 11.9 M |
| 1 param | 116 | 8.6 M |
| 2 params, 4 segments | 182 | 5.5 M |
| wildcard | 120 | 8.4 M |
| backtrack (static → param) | 202 | 4.9 M |
| 404 miss | 72 | 13.9 M |
| large table, param (1500 routes) | 208 | 4.8 M |

A 1500-route table costs roughly the same as a 6-route one, which is the property a trie is
chosen for. Routing is not where request time goes — see below — so this table exists to prove
the router is not a bottleneck, not to claim a win.

## Dispatch overhead (`dispatch.bench.ts`)

`Request` in, `Response` out: routing, context construction, handler invocation, response
coercion. No socket, no kernel, no load generator.

| scenario | oven | hono | elysia |
|---|---|---|---|
| static root | 1089 ns | 1069 ns | 479 ns |
| param + json | 1303 ns | 1819 ns | 898 ns |
| deep static | 1236 ns | 1284 ns | 596 ns |
| 404 miss | 1336 ns | 2013 ns | 588 ns |

**Reading this honestly:**

- Oven and Hono are within noise of each other on static routes; Oven is meaningfully ahead on
  parameterised JSON routes and on misses.
- **Elysia is roughly 2× faster than both, and that is not noise.** Elysia compiles each route
  into a specialised function with `new Function` at startup, so its hot path has no generic
  dispatch left in it. Oven interprets the same structure on every request. Closing that gap
  means adopting the same ahead-of-time compilation, which is tracked in `TODO.md` as a
  post-1.0 item — it is a large change and the wrong thing to attempt before the plugin and
  context contracts have stopped moving.
- Express is deliberately absent. It is built on Node's `req`/`res` and has no `Request` entry
  point, so putting it in this table would compare two different things in a way that flatters
  us. The Express comparison belongs in a socket-level benchmark with a real load generator.

**What this does not tell you.** Once a socket is involved, syscalls and TCP dominate and these
differences largely vanish — every framework here ends up limited by what `Bun.serve` can push.
A 600 ns gap matters when your handler does nothing; it is invisible next to a 2 ms database
query. Treat this as *"how much does the framework itself cost"*, not *"how fast will my API
be"*.

## Still missing

- Socket-level throughput with a real load generator (`oha` / `bombardier`), including Express.
- Memory per request under sustained load.
- Cold-start / boot time, which matters more than steady-state for serverless deployments.
