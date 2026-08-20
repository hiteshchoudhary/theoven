# @theoven/webhooks

[![npm](https://img.shields.io/npm/v/@theoven/webhooks)](https://www.npmjs.com/package/@theoven/webhooks)

> Inbound webhooks that are verified before your handler runs — Stripe, GitHub, Slack, Svix, Razorpay and Shopify.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun.

## Install

```bash
bun add @theoven/webhooks
```

## Usage

```ts title="src/routes/webhooks/stripe.post.ts"
import { stripe, webhook } from '@theoven/webhooks'
import { env } from '@theoven/core'

export default webhook(stripe({ secret: env.string('STRIPE_WEBHOOK_SECRET') }), async (ctx) => {
  // Reached only when the signature verified against the exact bytes that arrived.
  const event = ctx.webhook.payload as { type: string }

  await ctx.queue.dispatch(handleEvent, { event }, { key: ctx.webhook.id })
  return { received: true }
})
```

The ordering is the whole point, and it is the same argument as `auth: true` running before a
handler: an unverified delivery must be **unreachable**, not merely inconvenient to act on. A
handler that verifies on its first line is one early `return` away from not verifying.

## Providers

| | Header | Signs | Replay-protected |
| --- | --- | --- | --- |
| `stripe` | `Stripe-Signature` | `${timestamp}.${body}` | ✓ |
| `slack` | `X-Slack-Signature` | `v0:${timestamp}:${body}` | ✓ |
| `svix` | `svix-signature` | `${id}.${timestamp}.${body}` | ✓ |
| `github` | `X-Hub-Signature-256` | the body | ✗ |
| `razorpay` | `X-Razorpay-Signature` | the body | ✗ |
| `shopify` | `X-Shopify-Hmac-Sha256` | the body (base64) | ✗ |

`svix` covers **Clerk, Resend, Brex** and everything else built on Svix.

## Why it uses the raw body

A signature covers the exact bytes. Re-serialising a parsed body produces different ones — a
reordered key, a changed number format — and a signature that fails for reasons no amount of
staring at the JSON explains. This reads `ctx.rawBody`, which core keeps for precisely this.

## Limitations

- **Three providers cannot detect a replay.** GitHub, Razorpay and Shopify sign only the body, so
  a captured delivery is valid forever. `verifier.replayProtected` says so; deduplicate on
  `ctx.webhook.id` if it matters.
- **No delivery log.** Idempotency is yours — the queue's dedup keys are the usual answer.
- **JSON bodies only** for `ctx.webhook.payload`. `ctx.webhook.raw` is always there for the rest.

## Documentation

**[https://theoven.app/docs/bricks/webhooks/](https://theoven.app/docs/bricks/webhooks/)**

## License

MIT
