# Benchmarks

Run them yourself — numbers nobody can reproduce are marketing, not measurement.

```bash
bun benchmarks/router.bench.ts     # router lookup in isolation
bun benchmarks/dispatch.bench.ts   # Request -> Response, vs Hono
bun benchmarks/http.bench.ts       # real sockets, all four frameworks
```

Recorded on Bun 1.2.23 / Node 22.22, Apple Silicon, 2026-08-19. Socket figures are the mean of
two runs, dispatch figures the mean of three — a single run of a 5-second benchmark invites a
reader to reproduce it and get something else. Your absolute numbers will differ; the ratios are
the interesting part.

## HTTP throughput (`http.bench.ts`) — the one that matters

Real sockets, 50 connections, 5s per scenario, loopback. Every server exposes the same two
routes and is driven by the same load generator (`autocannon`).

| framework | runtime | static text req/s | param + json req/s | p99 |
| --- | --- | ---: | ---: | ---: |
| hono | bun | 114,348 | 109,920 | <1 ms |
| **oven** | **bun** | **109,261** | **106,163** | **<1 ms** |
| fastify | node | 84,230 | 81,171 | 1 ms |
| express | node | 18,482 | 18,339 | 5 ms |

**Oven is ~5.8× Express and ~1.3× Fastify. Hono is ~3.5% ahead of us on the parameterised route
and ~4.7% ahead on static text.**

Each framework runs on the runtime it is actually deployed on: Oven and Hono on Bun; Express and
Fastify on Node. Running the Node frameworks on Bun's `node:http` shim would
measure the shim rather than the framework, and "which should I deploy" is the honest question
anyway.

## Dispatch overhead (`dispatch.bench.ts`)

`Request` in, `Response` out — routing, context construction, handler invocation, response
coercion. No socket, no kernel, no load generator.

| scenario | oven | hono |
| --- | ---: | ---: |
| static root | 1664 ns | 1074 ns |
| param + json | 1931 ns | 1829 ns |
| deep static | 1826 ns | 1194 ns |
| 404 miss | 1910 ns | 1901 ns |

Express and Fastify are absent here because they have no `Request` entry point — including them
would compare two different things.

A framework that compiles each route into a specialised function at boot — with `new Function`,
so its hot path has no generic dispatch left — beats both numbers here comfortably. Oven
interprets the same structure on every request. That is a real and known gap; see the AOT item
in `TODO.md`.

### Read the two tables together

This is the whole lesson, and it currently runs against us.

On `static root` Hono dispatches **1.55× faster** than Oven — 590 ns of advantage. At the socket
that same pair is **4.7%** apart, not 55%. Once a real connection exists, syscalls and TCP
dominate and a few hundred nanoseconds of framework overhead compresses into near-nothing.

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
