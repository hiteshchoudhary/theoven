/**
 * Framework dispatch benchmark: Oven vs Hono.
 *
 * **What this measures:** the cost of taking a `Request` and producing a `Response` — routing,
 * context construction, handler invocation, and response coercion. All three frameworks expose
 * a `fetch(Request)` entry point, so this is an apples-to-apples comparison of framework
 * overhead with no socket, no kernel, and no load generator in the way.
 *
 * **What this does NOT measure:** real-world throughput. Once a socket is involved, syscalls and
 * TCP dominate and these differences largely disappear — every one of these frameworks will sit
 * at whatever `Bun.serve` can push. Treat this as "how much does the framework itself cost",
 * not "how many requests per second will my API serve".
 *
 * Express is deliberately absent: it is built on Node's `req`/`res` and has no `Request` entry
 * point, so including it here would compare two different things and flatter us dishonestly.
 * The Express comparison belongs in a socket-level benchmark with a real load generator.
 *
 * Run: bun benchmarks/dispatch.bench.ts
 */
import { Hono } from 'hono'
import { createApp, silentLogger } from '../packages/core/src/index'

const ITERATIONS = 200_000

type Dispatcher = (request: Request) => Response | Promise<Response>

// --- Oven --------------------------------------------------------------------------------
const oven = createApp({ logger: silentLogger })
oven.get('/', () => 'ok')
oven.get('/users/:id', (ctx) => ({ id: ctx.params.id }))
oven.get('/a/b/c/d/e', () => 'deep')

// --- Hono --------------------------------------------------------------------------------
const hono = new Hono()
hono.get('/', (c) => c.text('ok'))
hono.get('/users/:id', (c) => c.json({ id: c.req.param('id') }))
hono.get('/a/b/c/d/e', (c) => c.text('deep'))

const contenders: Array<{ name: string; dispatch: Dispatcher }> = [
  { name: 'oven', dispatch: (request) => oven.fetch(request) },
  { name: 'hono', dispatch: (request) => hono.fetch(request) },
]

const scenarios: Array<{ label: string; url: string }> = [
  { label: 'static root', url: 'http://localhost/' },
  { label: 'param + json', url: 'http://localhost/users/42' },
  { label: 'deep static', url: 'http://localhost/a/b/c/d/e' },
  { label: '404 miss', url: 'http://localhost/nope' },
]

async function measure(dispatch: Dispatcher, url: string): Promise<number> {
  // Warm up so JIT tiering settles before the clock starts.
  for (let i = 0; i < 20_000; i++) await dispatch(new Request(url))

  const start = Bun.nanoseconds()
  for (let i = 0; i < ITERATIONS; i++) await dispatch(new Request(url))
  return (Bun.nanoseconds() - start) / ITERATIONS
}

console.log(`\nDispatch overhead — ${ITERATIONS.toLocaleString()} requests per cell`)
console.log('Lower is better. Request construction is included in every measurement equally.\n')

const header = ['scenario'.padEnd(16), ...contenders.map((c) => c.name.padStart(12))].join('')
console.log(header)
console.log('-'.repeat(header.length))

for (const scenario of scenarios) {
  const cells: string[] = []
  for (const contender of contenders) {
    const nsPerOp = await measure(contender.dispatch, scenario.url)
    cells.push(`${nsPerOp.toFixed(0)} ns`.padStart(12))
  }
  console.log(scenario.label.padEnd(16) + cells.join(''))
}

console.log('')
