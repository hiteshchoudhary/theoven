# @theoven/queue

[![npm](https://img.shields.io/npm/v/@theoven/queue)](https://www.npmjs.com/package/@theoven/queue)

> Background jobs for Oven — retries, backoff, a dead letter and cron, in memory, in Redis, or in the Postgres you already run.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/queue
```

## Usage

```ts
import { defineJob, memoryQueue, queue } from '@theoven/queue'

const resize = defineJob<{ url: string }>({ name: 'resize', handler: async ({ payload, signal }) => {
  await fetch(payload.url, { signal })
}})

const app = createApp().use(queue(memoryQueue(), { jobs: [resize] }))

await ctx.queue.dispatch(resize, { url })   // wrong payload = compile error
```

The worker runs in your app process in development and not in production, where `oven worker`
scales separately. It imports your app module, so it has the same bricks and the same job
definitions.

Memory, Redis and Postgres drivers all pass the same conformance suite — a queue whose semantics
change with its backend is one you can only trust where you tested it.

## Documentation

**[https://theoven.app/docs/bricks/queue/](https://theoven.app/docs/bricks/queue/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
