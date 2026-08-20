# Benchmarks

Run them yourself — numbers nobody can reproduce are marketing, not measurement.

```bash
bun benchmarks/router.bench.ts     # router lookup in isolation
bun benchmarks/dispatch.bench.ts   # Request -> Response, vs Hono
bun benchmarks/http.bench.ts       # real sockets, all four frameworks
bun benchmarks/image.bench.ts      # Bun.Image, and the cost of the upload guard
```

Recorded on **Bun 1.4.0** / Node 22.22, Apple Silicon, 2026-08-21. Socket figures are the mean of
two runs, dispatch figures the mean of three — a single run of a 5-second benchmark invites a
reader to reproduce it and get something else. Your absolute numbers will differ; the ratios are
the interesting part.

The previous run, on Bun 1.2.23, is quoted below wherever it moved. One of those moves
contradicts a claim this page used to make, which is the reason it is quoted rather than
overwritten.

## HTTP throughput (`http.bench.ts`) — the one that matters

Real sockets, 50 connections, 5s per scenario, loopback. Every server exposes the same two
routes and is driven by the same load generator (`autocannon`).

| framework | runtime | static text req/s | param + json req/s | p99 |
| --- | --- | ---: | ---: | ---: |
| hono | bun | 94,765 | 95,911 | 1 ms |
| **oven** | **bun** | **93,805** | **94,087** | **1 ms** |
| fastify | node | 80,084 | 77,824 | 1 ms |
| express | node | 18,155 | 18,072 | 5 ms |

**Oven is ~5.2× Express and ~1.21× Fastify, and level with Hono — 1.9% behind on the
parameterised route, 1.0% behind on static text, both inside run-to-run variance.**

Each framework runs on the runtime it is actually deployed on: Oven and Hono on Bun; Express and
Fastify on Node. Running the Node frameworks on Bun's `node:http` shim would measure the shim
rather than the framework, and "which should I deploy" is the honest question anyway.

### Everything got slower than the 1.2.23 run, and we do not know why

| framework | then | now | change |
| --- | ---: | ---: | ---: |
| hono | 108,845 | 95,911 | −11.9% |
| oven | 108,250 | 94,087 | −13.1% |
| fastify | 80,896 | 77,824 | −3.8% |
| express | 18,389 | 18,072 | −1.7% |

Express and Fastify did not change runtime — same Node 22.22, same code — so their −1.7% and
−3.8% set the floor for how much this machine drifts between sessions. Both Bun frameworks fell
roughly three times further than that floor, and they fell together.

We are not going to claim that is a Bun 1.4 regression on the strength of one laptop running its
own load generator, and we are not going to quietly restate the numbers as though nothing moved.
It is one machine, thermally unknown, with `autocannon` competing for the same cores. What we can
say is that the *ranking* is unchanged and the Oven-to-Hono gap is unchanged. Anyone with a
two-machine setup who wants to settle it would be doing us a favour.

## Dispatch overhead (`dispatch.bench.ts`)

`Request` in, `Response` out — routing, context construction, handler invocation, response
coercion. No socket, no kernel, no load generator.

| scenario | oven | hono | then: oven | then: hono |
| --- | ---: | ---: | ---: | ---: |
| static root | 1051 ns | 406 ns | 1258 ns | 1086 ns |
| param + json | 1255 ns | 916 ns | 1519 ns | 1838 ns |
| deep static | 1176 ns | 477 ns | 1423 ns | 1193 ns |
| 404 miss | 1228 ns | 956 ns | 1530 ns | 1922 ns |

**This page used to say Oven dispatched 1.21× faster than Hono on a parameterised route and
1.26× faster on a 404. On Bun 1.4 that is no longer true, and it is worth being plain about it.**

Oven got about 17% faster. Hono got 2.0–2.7× faster and now leads every one of the four
scenarios. The most likely explanation is in Bun's own release notes: 1.4 rewrote the RegExp
engine, and Hono's router is regular-expression driven where ours walks a radix tree by hand.
A runtime improvement that lands squarely on a competitor's hot path is still a real result.

We have not re-litigated [D2](../CLAUDE.md) over it. The router is 1% of request time (below),
and the socket table above is what a deployment feels. But the gap is now consistently against
us on dispatch, and pretending otherwise would make every other number here less trustworthy.

Express and Fastify are absent from this table because they have no `Request` entry point —
including them would compare two different things.

A framework that compiles each route into a specialised function at boot — with `new Function`,
so its hot path has no generic dispatch left — beats both numbers here comfortably. Oven
interprets the same structure on every request. That is a real and known gap; see the AOT item
in `TODO.md`.

### Read the two tables together

This is the whole lesson, and it survived the numbers changing underneath it — it is arguably
clearer now than it was.

Hono dispatches **2.6× faster** on a static root and **1.37× faster** on a parameterised route.
At the socket, those advantages collapse to **1.0%** and **1.9%**. Once a real connection exists,
syscalls and TCP dominate, and several hundred nanoseconds of framework overhead compress into
near-nothing.

So: the dispatch table is a useful engineering signal about where our own overhead lives, and a
**bad** basis for choosing a framework. We publish both because publishing only the flattering
one would be dishonest, and publishing only the microbenchmark would be misleading in the other
direction. That was easy to write when the microbenchmark flattered us; it is the same sentence
now that it does not.

## Router lookup (`router.bench.ts`)

| scenario | ns/op | ops/s |
| --- | ---: | ---: |
| static, root | 40 | 24.8 M |
| static, 1 segment | 89 | 11.2 M |
| 1 param | 123 | 8.1 M |
| 2 params, 4 segments | 188 | 5.3 M |
| wildcard | 129 | 7.8 M |
| backtrack (static → param) | 188 | 5.3 M |
| 404 miss | 79 | 12.7 M |
| large table, static (1500 routes) | 168 | 6.0 M |
| large table, param (1500 routes) | 207 | 4.8 M |

A 1500-route table costs about the same as a 6-route one, which is the property a trie is chosen
for. At ~94k req/s the router accounts for roughly **1%** of request time — this table exists to
prove it is not a bottleneck, not to claim a win.

## Image processing (`image.bench.ts`)

`Bun.Image`, which is what [`@theoven/image`](../packages/image) is built on. The interesting
number is not how fast a resize is — it is how much cheaper reading a header is than decoding
the pixels, because that ratio is the entire basis for guarding an upload.

| source | on the wire | header read | resize + encode |
| --- | ---: | ---: | ---: |
| 800×600 (0.5 MP) | 3 KB | 0.8 µs | 3.8 ms |
| 2000×1500 (3.0 MP) | 15 KB | 0.4 µs | 7.7 ms |
| 4000×4000 (16 MP) | 70 KB | 0.6 µs | 44.4 ms |

**Reading the header is constant time; decoding is linear in pixels.** That is why the guard
works: a 70 KB request body carrying 16 megapixels is refused in well under a microsecond, and
the gap only widens as the attack gets bigger. Byte limits alone cannot see that upload coming —
70 KB is unremarkable.

Encoding a 2000×1500 source down to 512 wide:

| format | output | time |
| --- | ---: | ---: |
| jpeg | 8 KB | 6.1 ms |
| png | 2 KB | 18.3 ms |
| webp | 2 KB | 13.5 ms |

A `srcset` ladder at 320/640/1280 costs **83 ms**, because each width is its own decode —
pipelines do not share one. That is a queue job, not a request. A ThumbHash placeholder is
**7 ms**.

And the property that decides whether any of this belongs in a request at all:

```
110 ms resize saw 87 timer ticks — off-thread, the server keeps serving
```

Image work does not block the event loop. A resize in a handler costs that request its latency,
not the whole process's.

## Caveats

- **Loopback only.** No real network, so latency numbers are a floor, not a forecast.
- **Empty handlers.** Every framework here is fast compared to a 2 ms database query. These
  numbers measure framework overhead, which is rarely what limits an API.
- **Single machine, load generator included.** `autocannon` competes with the servers for CPU,
  which compresses the top of the table. Treat >90k req/s results as "at the ceiling".
- **Image figures are warm.** Each is the mean of 10–50 runs after a warm-up, so they exclude
  first-call JIT and codec initialisation.
- **`backend: "system"`.** The image numbers were taken on macOS. A Linux server runs the `bun`
  backend, which produces byte-identical JPEG/PNG/WebP but may differ in speed.

## Still missing

- Memory per request under sustained load.
- Cold-start / boot time, which matters more than steady-state for serverless.
- A multi-machine run where the load generator is not stealing CPU from the server — which would
  also settle the Bun 1.2 → 1.4 throughput question above.
