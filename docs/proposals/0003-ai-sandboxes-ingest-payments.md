# Proposal 0003 — AI, sandboxes, ingest and payments

Status: **draft for review — no decisions taken**
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
| **Ingest** | *ambiguous* — two different products | ⚠️ **needs your call** | ? |
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

## Ingest — which one do you mean?

"Ingest" is two different products and I do not want to guess.

### (a) Document ingestion for RAG

Parse → chunk → embed → store. Pairs with `vector`, `storage` and `queue`.

```ts
await ctx.ingest.document(file, { collection: 'handbook', chunk: { size: 800, overlap: 100 } })
```

Parsers for PDF, DOCX, HTML and Markdown; chunkers; and the pipeline that puts the pieces
together as a queue job so a 200-page upload does not block a request.

**Concern:** this is less a contract than a pipeline. The parsers are libraries, not swappable
implementations of one interface — a PDF parser and an HTML parser do not implement the same thing
in any meaningful sense. It may be better as *documentation and a recipe* over `vector` + `queue` +
`storage` than as a brick. Worth arguing about.

### (b) Inngest — durable workflows

Steps that survive restarts, sleep for days, and retry individually.

```ts
export const onboarding = workflow('onboarding', async (step) => {
  await step.run('create-user', () => …)
  await step.sleep('wait-a-day', '24h')
  await step.run('send-tips', () => …)
})
```

Contract over Inngest, Temporal, and possibly our own queue for the simple cases. This is a
**much larger** and more interesting brick than (a), and it overlaps the queue brick in ways that
need thinking about — a durable workflow is not a job, but it is made of them.

**Please pick.** They share a name and nothing else.

---

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
7. **`ingest`** — after you tell me which one it is

---

## Decisions this would need

| | |
| --- | --- |
| **D38** | AI: wrap the AI SDK rather than write model adapters. |
| **D39** | Payments: narrow contract; subscriptions stay provider-specific behind capabilities. |
| **D40** | Sandbox isolation is a declared capability, and limits are required arguments. |
| **D41** | Which "ingest" — and, if RAG, whether it is a brick at all or a recipe. |
