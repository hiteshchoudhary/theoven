# @theoven/ai

The infrastructure around an AI SDK call — streaming as SSE, caching, token accounting and budgets.

```bash
bun add @theoven/ai ai @ai-sdk/openai
```

```ts
import { openai } from '@ai-sdk/openai'
import { ai } from '@theoven/ai'

const app = createApp().use(ai({ model: openai('gpt-4o-mini') }))
```

```ts
// src/routes/chat.post.ts
export default (ctx) => ctx.ai.stream({ prompt: ctx.body.prompt })
```

## What it does not do

It does not wrap the AI SDK's model layer. Providers, prompts, tools and structured output are
the SDK's job, it does them well, and re-exporting them under our own names would age badly and
teach a model nothing it already knows.

What is missing when you call the SDK straight from a route is everything *around* the call:

- **Streaming as SSE** — `ctx.ai.stream(...)` returns a `Response` you can return.
- **Aborting on disconnect** — a client hanging up cancels the provider call instead of leaving
  it generating and billing.
- **Not paying twice** — identical calls are cached, and identical calls *in flight at once*
  share a single provider call.
- **Knowing what it cost** — token counts and, when you supply prices, money.
- **Budgets** — a request that has spent its allowance stops making calls.

## Honest limits

- **A budget bounds how many calls a request makes, not how large one call is.** Token counts
  are not known until the provider answers. Use `maxOutputTokens` for the per-call ceiling.
- **Caching makes generation deterministic for the TTL.** Right for classification and
  embeddings; wrong for anything a user expects to vary. It is off unless configured.
- **Cost is `undefined` unless you supply pricing**, and stays `undefined` when the provider
  reports no tokens. It is never silently `0`.
- **Calls carrying tools are never cached** — a tool holds a function, which cannot be keyed.
- **In-flight deduplication is per process**, not across a cluster.

Full documentation: <https://theoven.app/docs/bricks/ai/>

MIT
