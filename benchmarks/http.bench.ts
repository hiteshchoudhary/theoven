/**
 * Socket-level HTTP benchmark: Oven vs Hono vs Fastify vs Express.
 *
 * This is the benchmark that includes Express and Fastify, because it is the only kind that
 * can. Both are built on Node's `req`/`res` and have no `Request` entry point, so they cannot
 * appear in `dispatch.bench.ts` — comparing them there would be comparing two different things.
 *
 * Every server exposes the same two routes and is driven by the same load generator over a real
 * socket, which is what an actual deployment looks like.
 *
 * **Runtime choice matters here, so it is explicit.** Each framework runs on the runtime it is
 * actually deployed on: Oven and Hono on Bun; Express and Fastify on Node. Running the
 * Node frameworks on Bun's `node:http` compatibility layer would measure Bun's shim rather than
 * the framework, and running them on Node is the honest question anyway — this is the choice a
 * team actually makes.
 *
 * Run: bun benchmarks/http.bench.ts
 */
import { spawn } from 'bun'

const DURATION_SECONDS = 5
const CONNECTIONS = 50
const BASE_PORT = 41_000

interface Contender {
  name: string
  runtime: 'bun' | 'node'
  script: string
}

const CONTENDERS: Contender[] = [
  { name: 'oven', runtime: 'bun', script: 'benchmarks/servers/oven.server.ts' },
  { name: 'hono', runtime: 'bun', script: 'benchmarks/servers/hono.server.ts' },
  { name: 'fastify', runtime: 'node', script: 'benchmarks/servers/fastify.server.mjs' },
  { name: 'express', runtime: 'node', script: 'benchmarks/servers/express.server.mjs' },
]

const SCENARIOS = [
  { label: 'static text', path: '/' },
  { label: 'param + json', path: '/users/42' },
]

interface Result {
  requestsPerSecond: number
  latencyP99: number
  non2xx: number
}

/** Polls until the server answers, so we never benchmark a process that is still booting. */
async function waitForReady(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) {
        await response.text()
        return true
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100)
  }
  return false
}

async function runAutocannon(port: number, path: string): Promise<Result> {
  const proc = spawn({
    cmd: [
      'bunx',
      'autocannon',
      '-c',
      String(CONNECTIONS),
      '-d',
      String(DURATION_SECONDS),
      '-j',
      `http://127.0.0.1:${port}${path}`,
    ],
    stdout: 'pipe',
    stderr: 'ignore',
  })

  const output = await new Response(proc.stdout).text()
  await proc.exited

  const report = JSON.parse(output) as {
    requests: { average: number }
    latency: { p99: number }
    non2xx: number
  }

  return {
    requestsPerSecond: report.requests.average,
    latencyP99: report.latency.p99,
    non2xx: report.non2xx,
  }
}

async function benchmark(contender: Contender, port: number): Promise<Result[] | null> {
  const server = spawn({
    cmd: [contender.runtime, contender.script],
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
    stdout: 'ignore',
    stderr: 'ignore',
  })

  try {
    if (!(await waitForReady(port))) {
      console.error(`  ${contender.name}: failed to start, skipping`)
      return null
    }

    const results: Result[] = []
    for (const scenario of SCENARIOS) {
      results.push(await runAutocannon(port, scenario.path))
    }
    return results
  } finally {
    server.kill()
    await server.exited
  }
}

console.log(
  `\nHTTP throughput — ${CONNECTIONS} connections, ${DURATION_SECONDS}s per scenario, localhost\n`,
)

const rows: Array<{ contender: Contender; results: Result[] }> = []
let port = BASE_PORT

for (const contender of CONTENDERS) {
  process.stdout.write(`  running ${contender.name} (${contender.runtime})...\n`)
  const results = await benchmark(contender, port++)
  if (results) rows.push({ contender, results })
}

console.log('')
const header = [
  'framework'.padEnd(12),
  'runtime'.padEnd(9),
  ...SCENARIOS.map((s) => `${s.label} req/s`.padStart(20)),
  'p99 (ms)'.padStart(10),
].join('')
console.log(header)
console.log('-'.repeat(header.length))

// Sort by the parameterised-JSON scenario: closest of the two to real API work.
rows.sort((a, b) => (b.results[1]?.requestsPerSecond ?? 0) - (a.results[1]?.requestsPerSecond ?? 0))

for (const { contender, results } of rows) {
  const cells = results.map((r) => Math.round(r.requestsPerSecond).toLocaleString().padStart(20))
  const p99 = (results[1]?.latencyP99 ?? 0).toFixed(1).padStart(10)
  console.log(contender.name.padEnd(12) + contender.runtime.padEnd(9) + cells.join('') + p99)

  const failures = results.reduce((sum, r) => sum + r.non2xx, 0)
  if (failures > 0) console.log(`  ${contender.name}: ${failures} non-2xx responses — suspect`)
}

console.log('')
