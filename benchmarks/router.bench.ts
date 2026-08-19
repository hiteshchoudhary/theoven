/**
 * Router micro-benchmark.
 *
 * Measures lookup only — no HTTP, no context, no handler. The comparative benchmark against
 * Express/Hono lives in `benchmarks/server.bench.ts` and needs the server layer
 * (Phase 1.2) before it can be meaningful.
 *
 * Run: bun benchmarks/router.bench.ts
 */
import { Router } from '../packages/core/src/router/router'

const ITERATIONS = 1_000_000

function bench(name: string, fn: () => void): void {
  // Warm up so we measure steady-state, not JIT tiering.
  for (let i = 0; i < 100_000; i++) fn()

  const start = Bun.nanoseconds()
  for (let i = 0; i < ITERATIONS; i++) fn()
  const elapsed = Bun.nanoseconds() - start

  const nsPerOp = elapsed / ITERATIONS
  const opsPerSec = 1e9 / nsPerOp
  console.log(
    `${name.padEnd(38)} ${nsPerOp.toFixed(1).padStart(7)} ns/op  ${(opsPerSec / 1e6)
      .toFixed(2)
      .padStart(7)} M ops/s`,
  )
}

const small = new Router<number>()
small.insert('GET', '/', 0)
small.insert('GET', '/users', 1)
small.insert('GET', '/users/:id', 2)
small.insert('GET', '/users/:id/posts/:postId', 3)
small.insert('GET', '/files/*path', 4)
small.insert('GET', '/files/public/list', 5)

const large = new Router<number>()
for (let i = 0; i < 500; i++) {
  large.insert('GET', `/api/v1/resource${i}`, i)
  large.insert('GET', `/api/v1/resource${i}/:id`, i)
  large.insert('POST', `/api/v1/resource${i}/:id/action`, i)
}

console.log(`\nOven router — ${ITERATIONS.toLocaleString()} iterations each\n`)

bench('static, root', () => small.find('GET', '/'))
bench('static, 1 segment', () => small.find('GET', '/users'))
bench('1 param', () => small.find('GET', '/users/42'))
bench('2 params, 4 segments', () => small.find('GET', '/users/42/posts/7'))
bench('wildcard', () => small.find('GET', '/files/a/b/c.txt'))
bench('backtrack (static -> param)', () => small.find('GET', '/files/public/other'))
bench('404 miss', () => small.find('GET', '/nope/nope'))
bench('405 miss', () => small.find('DELETE', '/users'))
bench('large table, static (1500 routes)', () => large.find('GET', '/api/v1/resource499'))
bench('large table, param (1500 routes)', () => large.find('GET', '/api/v1/resource499/abc'))

console.log('')
