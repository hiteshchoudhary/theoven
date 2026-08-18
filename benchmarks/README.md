# Benchmarks

Run them yourself — numbers nobody can reproduce are marketing, not measurement.

```bash
bun benchmarks/router.bench.ts     # router lookup in isolation
bun benchmarks/dispatch.bench.ts   # Request -> Response, vs Hono and Elysia
bun benchmarks/http.bench.ts       # real sockets, all five frameworks
```

Recorded on Bun 1.2.23 / Node 22.22, Apple Silicon, 2026-08-19. Your absolute numbers will
differ; the ratios are the interesting part.

## HTTP throughput (`http.bench.ts`) — the one that matters

Real sockets, 50 connections, 5s per scenario, loopback. Every server exposes the same two
routes and is driven by the same load generator (`autocannon`).

| framework | runtime | static text req/s | param + json req/s | p99 |
| --- | --- | ---: | ---: | ---: |
| elysia | bun | 114,106 | 113,325 | <1 ms |
| **oven** | **bun** | **114,451** | **110,483** | **<1 ms** |
| hono | bun | 114,682 | 101,011 | 1 ms |
| fastify | node | 84,397 | 81,581 | 1 ms |
| express | node | 18,501 | 18,331 | 5 ms |

**Oven is ~6× Express and ~1.35× Fastify, and sits level with Elysia and Hono.**

Each framework runs on the runtime it is actually deployed on: Oven, Hono and Elysia on Bun;
Express and Fastify on Node. Running the Node frameworks on Bun's `node:http` shim would
measure the shim rather than the framework, and "which should I deploy" is the honest question
anyway.

## Dispatch overhead (`dispatch.bench.ts`)

`Request` in, `Response` out — routing, context construction, handler invocation, response
coercion. No socket, no kernel, no load generator.

| scenario | oven | hono | elysia |
| --- | ---: | ---: | ---: |
| static root | 1089 ns | 1069 ns | 479 ns |
| param + json | 1303 ns | 1819 ns | 898 ns |
| deep static | 1236 ns | 1284 ns | 596 ns |
| 404 miss | 1336 ns | 2013 ns | 588 ns |

Express and Fastify are absent here because they have no `Request` entry point — including them
would compare two different things.

**Elysia is roughly 2× faster than Oven in this table.** It compiles each route into a
specialised function with `new Function` at boot, so its hot path has no generic dispatch left.
Oven interprets the same structure on every request.

### Read the two tables together

This is the whole lesson. Elysia's 2× dispatch advantage is **worth 2.5% at the socket** —
113,325 vs 110,483 req/s, which is inside run-to-run variance. Once a real connection exists,
syscalls and TCP dominate and a ~600 ns framework difference disappears into the noise.

So: the dispatch table is a useful engineering signal about where our own overhead lives, and a
**bad** basis for choosing a framework. We publish both because publishing only the flattering
one would be dishonest, and publishing only the microbenchmark would be misleading in the other
direction.

## Router lookup (`router.bench.ts`)

| scenario | ns/op | ops/s |
| --- | ---: | ---: |
| static, root | 28 | 36.3 M |
| static, 1 segment | 84 | 11.9 M |
| 1 param | 116 | 8.6 M |
| 2 params, 4 segments | 182 | 5.5 M |
| wildcard | 120 | 8.4 M |
| backtrack (static → param) | 202 | 4.9 M |
| 404 miss | 72 | 13.9 M |
| large table, param (1500 routes) | 208 | 4.8 M |

A 1500-route table costs about the same as a 6-route one, which is the property a trie is
chosen for. At ~110k req/s the router accounts for roughly **1%** of request time — this table
exists to prove it is not a bottleneck, not to claim a win.

## Caveats

- **Loopback only.** No real network, so latency numbers are a floor, not a forecast.
- **Empty handlers.** Every framework here is fast compared to a 2 ms database query. These
  numbers measure framework overhead, which is rarely what limits an API.
- **Single machine, load generator included.** `autocannon` competes with the servers for CPU,
  which compresses the top of the table. Treat >100k req/s results as "at the ceiling".

## Still missing

- Memory per request under sustained load.
- Cold-start / boot time, which matters more than steady-state for serverless.
- A multi-machine run where the load generator is not stealing CPU from the server.
