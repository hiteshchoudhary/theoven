# Proposal 0003 — AI, sandboxes, ingest and payments

Status: **D38 and D41 answered; D39 and D40 still open**
Context: the next phase of bricks. This is a list to argue with, not a plan to execute.

---

## The bar each of these has to clear

Three tests, from decisions already locked:

1. **Is it a brick at all?** It must put a capability on the context that a real app optionally
   wants. Things every app needs go in core (principle 2); things that wrap a request are
   middleware, not bricks.
2. **Does a contract survive a second implementation?** D14. `db-drizzle` alone proved nothing;
   `db-mongoose` proved the contract. A contract with one adapter is a guess.
3. **Does it invent?** Where two providers genuinely disagree, the contract exposes the difference
   (D19) rather than giving one of them a method to fake.

Two proposals below fail test 2 as originally imagined, and say so.

---

## Summary

| | Brick | Verdict | Size |
| --- | --- | --- | --- |
| **AI** | `@theoven/ai` | ✅ but **not as model adapters** — see below | M |
| | `@theoven/vector` + 4 adapters | ✅ strongest candidate in the set | M |
| **Sandboxes** | `@theoven/sandbox` + 3 adapters | ✅ clean contract, highest security risk | L |
| **Ingest** | `@theoven/inngest` | ✅ direct integration, no contract yet | L |
| **Payments** | `@theoven/payments` + 3 adapters | ✅ with a deliberately narrow contract | L |
| | `@theoven/webhooks` | ✅ small, broadly useful, groundwork already exists | S |
| **Debt** | `@theoven/ratelimit` | ✅ the docs already promise this | S |

---

## AI

### The honest problem with the obvious version

The obvious shape is `@theoven/ai` plus `ai-openai`, `ai-anthropic`, `ai-google`, `ai-ollama` —
a contract over `generate`, `stream`, `embed`.

It would work. It is also **reimplementing the Vercel AI SDK**, which does exactly this across
thirty-odd providers, is maintained full time, and tracks a model landscape that changes weekly.
Every new model capability — reasoning tokens, computer use, cached prompts, structured outputs —
would reach us late. We would spend the phase catching up and still be behind.

D14 says contracts exist so implementations are swappable. It does not say we have to write the
implementations when somebody already maintains better ones.

### Answer: yes, leverage it — verified under Bun

`ai@7` and `@ai-sdk/openai` install and run on Bun. A real `generateText` call reached OpenAI and
failed only on the invalid key, so fetch, streaming and the provider spec all work — checked rather
than assumed, because Mongoose 9 taught us that "it is JavaScript" is not the same as "it runs on
Bun".

The SDK is a **peer dependency**: you install `ai` and whichever provider you want, we never pin a
model package, and a new provider needs nothing from us.

### What to build instead

**One brick, no model adapters.** `@theoven/ai` takes an AI SDK model as configuration and adds
what a *backend framework* uniquely can:

```ts
import { openai } from '@ai-sdk/openai'
import { ai } from '@theoven/ai'

app.use(ai({ model: openai('gpt-4o'), budget: { perUser: 100_000 } }))
```

| What it adds | Why it belongs here and not in the AI SDK |
| --- | --- |
| **Streaming plumbed to a route** | `sse()` is already in core; a handler returning `ctx.ai.stream(…)` should just work, with the abort signal wired so a closed tab stops the generation |
| **Response caching** | the [cache brick](/docs/bricks/cache/) already has stampede protection — identical prompts collapsing to one call is the single biggest cost saving and nobody does it by default |
| **Token and cost accounting** | per request on `ctx`, per user in a table — the thing every AI product builds by hand and gets wrong |
| **Budgets and rate limits by token** | limiting requests is useless when one request can cost a dollar |
| **Long generations as jobs** | dispatch to the [queue](/docs/bricks/queue/) with the result written back, rather than a 90-second HTTP request |
| **Traced spans** | [telemetry](/docs/bricks/telemetry/) already names spans by route; model calls become child spans with token counts |

That is a much smaller brick, it does not rot when a new model ships, and it is defensible: it is
the *infrastructure* around inference, which is exactly what this framework is for.

### `@theoven/vector`

The strongest candidate in the whole proposal, and a genuine contract-plus-adapters case.

| Adapter | Why it earns a place |
| --- | --- |
| `vector-sqlite` | `sqlite-vec` over `bun:sqlite` — RAG with **no server to provision**, the same argument as the SQLite default (D21) |
| `vector-pg` | pgvector, for apps already running Postgres |
| `vector-qdrant` | a real vector database, for scale |
| `vector-pinecone` | hosted, for people who want none of the above |

Contract: `upsert`, `query(embedding, k, filter)`, `delete`, `namespace`. Structurally different
implementations — an extension in a SQL table versus a hosted HTTP service — which is exactly the
test D14 asks for.

**Risk:** metadata filtering diverges sharply between engines. The contract should support equality
filters only and expose the rest through `raw`, rather than inventing a query language that is
worse than all four.

---

## Sandboxes

Running untrusted code. The natural companion to AI agents, and clean to model:

```ts
const box = await ctx.sandbox.create({ runtime: 'python', timeout: 30_000 })
const result = await box.run('print(sum(range(100)))')
await box.files.write('/data.csv', csv)
await box.destroy()
```

| Adapter | |
| --- | --- |
| `sandbox-e2b` | the obvious hosted default |
| `sandbox-modal` | for teams already there |
| `sandbox-docker` | local, so it works before you have an account — and refuses to boot in production unless explicitly allowed, exactly as `memoryQueue` does |

Contract test: E2B's hosted API and a local Docker socket are about as structurally different as
two implementations get. Passes.

**This is the most dangerous brick in the set**, and the design has to lead with that:

- **Isolation is a declared capability, not an assumption.** A driver states what it actually
  isolates — process, container, microVM — and an application can refuse to run on less.
- **Timeouts and resource limits are required arguments**, not optional ones with generous
  defaults. A sandbox with no limit is a fork bomb waiting for a prompt injection.
- **Network access off by default.** An agent that can `curl` your metadata endpoint is an SSRF
  with extra steps.
- The local driver must be **hard** to run in production accidentally.

---

## Ingest — it is Inngest

Durable execution: functions made of steps that are individually memoised, so a retry resumes from
the step that failed rather than from the beginning.

```ts
inngest.createFunction({ id: 'onboarding', triggers: { event: 'user/created' } },
  async ({ event, step }) => {
    await step.run('provision', () => provision(event.data.userId))
    await step.sleep('settle', '24h')
    const upgraded = await step.waitForEvent('upgraded', { event: 'plan/upgraded', timeout: '30d' })
    await step.run('email', () => sendTips(event.data.userId, upgraded))
  })
```

### This is not our queue with extra features

Worth being precise, because the two look adjacent and are not:

| | [`@theoven/queue`](/docs/bricks/queue/) | Inngest |
| --- | --- | --- |
| Unit | a job | a function of steps |
| Retry granularity | the **whole handler** re-runs | **the failed step**; earlier ones replay from memo |
| Waiting | `delay` / `runAt`, in ms | `step.sleep('24h')`, `step.waitForEvent(…, '30d')` |
| Triggered by | `dispatch(job, payload)` | an **event**, with fan-out to every matching function |
| Flow control | `concurrency` per worker | per-tenant concurrency, throttling, debounce, rate limits |
| Runs where | your worker, your infrastructure | Inngest calls **your app** over HTTP |
| State | a row per job | durable execution state per run |

A background job and a durable workflow are different primitives. The queue brick stays exactly as
it is; this sits beside it.

### Shape: a direct integration, not a contract — yet

The obvious version is `@theoven/workflow` plus `workflow-inngest`, `workflow-temporal` and one
over our own queue.

**By our own rule that would be premature.** D14 exists because `db-drizzle` alone proved nothing —
a contract with one implementation is a guess, shaped around the only thing it has ever met. There
is no second implementation here today, and writing our own durable executor (deterministic replay,
per-step memoisation, a `workflow_runs` table) is a project in itself, not an adapter.

So: **`@theoven/inngest`, a direct integration**, exactly as
[`auth-better`](/docs/bricks/auth-better/) wraps better-auth rather than pretending to abstract it.
Extract a contract if and when a second executor lands.

What the brick does:

| | |
| --- | --- |
| Mounts Inngest's serve handler | the `routes` capability (D19) — Inngest calls your app, so it needs an endpoint |
| Puts the client on the context | `ctx.inngest.send({ name, data })` to emit events from a handler |
| Registers functions at boot | so `oven routes` shows what is mounted, and a missing one fails at startup |
| Wires the signing key | verified against `ctx.rawBody`, the same machinery as webhooks |
| Traces steps | child spans through the [telemetry brick](/docs/bricks/telemetry/) |

**Not wrapping AgentKit.** It is Inngest's agent framework and moves fast; the same argument that
keeps us out of the agent business generally.

**Honest limitation to put on the page:** this makes your app depend on a hosted service to run
its workflows. Inngest self-hosts, so it is not a lock-in argument — but it is a second thing to
operate, and an app that only needs "run this later" should use the queue.

## Payments

The hardest contract in the proposal, and the one most likely to be built wrong.

### What the contract can honestly cover

| | Stripe | Razorpay | Paddle | Contract? |
| --- | --- | --- | --- | --- |
| Create a checkout / order | ✓ | ✓ | ✓ | **yes** |
| Verify a webhook signature | ✓ | ✓ | ✓ | **yes** |
| Fetch a payment by id | ✓ | ✓ | ✓ | **yes** |
| Refund | ✓ | ✓ | ✓ | **yes** |
| Subscription lifecycle | plans, prices, schedules | plans, subscriptions | products, prices, seats | **no** |
| Tax | Stripe Tax | manual | merchant of record | **no** |

The first four are a real intersection. Subscriptions are not — Paddle is a merchant of record and
handles tax and dunning itself; Stripe hands you the primitives and expects you to. A contract that
unified them would be lying to at least one.

So: **narrow contract, declared capabilities, `raw` for the rest.** Subscriptions stay
provider-specific and the pages say so.

### What we uniquely add

- **`ctx.rawBody` already exists for exactly this.** Its doc comment names Stripe by name —
  re-serialising parsed JSON gives different bytes and a failing signature, which is a genuinely
  miserable afternoon. The groundwork is done.
- **A webhook route that verifies before your handler runs**, the same way `auth: true` runs
  before a handler.
- **Idempotency** through the queue's dedup keys — a webhook delivered twice must not charge
  twice, and providers retry by design.
- **Webhook → job**, so a slow handler does not cause the provider to retry.

Adapters: `payments-stripe`, `payments-razorpay`, `payments-paddle`. Razorpay because you asked for
it earlier, and because it is genuinely underserved outside PHP and Node.

---

## `@theoven/webhooks`

Smallest thing here, and possibly the most immediately useful. Signature verification for inbound
webhooks generally — Stripe, GitHub, Slack, Clerk, Shopify, Razorpay — each of which signs
differently and each of which is got wrong the same way.

```ts
export const post = webhookRoute(github({ secret: env.string('GH_SECRET') }), async (ctx) => {
  // Only reached when the signature verified against the raw bytes.
})
```

It is small, it uses machinery that already exists, and it turns a class of security bug into a
line of configuration. It is also a natural dependency of `payments`.

---

## Paying off a promise

`@theoven/ratelimit` — a Redis-backed limiter.

The [middleware docs](/docs/reference/middleware/#rate-limiting) and the source comment in
`middleware.ts` both say *"a Redis-backed limiter arrives with `@theoven/queue`."* It never did.
The in-memory limiter is per process, so behind a load balancer the effective limit is
`limit × instances` — which the page admits but the promise does not.

Small, overdue, and it removes a documented claim that is not true.

---

## What I would not build

- **A model adapter per AI provider.** See above.
- **An LLM-agnostic prompt templating language.** Prompts are strings; a DSL is a second thing to
  learn that produces strings.
- **An agent framework.** Loops, tool dispatch and planning are an application concern and a very
  fast-moving one. The sandbox and AI bricks are the *infrastructure* an agent needs; the agent is
  not ours to write.
- **A payments UI.** Checkout pages are the provider's job and they are better at it.

---

## Suggested order

1. **`webhooks`** — small, unblocks payments, useful alone
2. **`ratelimit`** — pays off an existing promise
3. **`vector`** — strongest contract, and AI depends on it being there
4. **`ai`** — once vector exists, this is mostly plumbing
5. **`payments`** — largest, and best done after `webhooks` proves the signature machinery
6. **`sandbox`** — deliberately last: highest risk, and it wants the AI brick to exist to be worth
   anything
7. **`inngest`** — last, and independent of the rest

---

## Decisions this would need

| | |
| --- | --- |
| ~~D38~~ | ~~AI: wrap the AI SDK~~ — **answered: yes.** Peer dependency, verified working on Bun. |
| **D39** | Payments: narrow contract; subscriptions stay provider-specific behind capabilities. |
| **D40** | Sandbox isolation is a declared capability, and limits are required arguments. |
| ~~D41~~ | ~~Which "ingest"~~ — **answered: Inngest.** Shipped as a direct integration, not a contract, until a second durable executor exists to prove one. |
