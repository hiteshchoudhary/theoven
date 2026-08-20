import { afterEach, describe, expect, test } from 'bun:test'
import { type App, createApp, silentLogger } from '@theoven/core'
import { github } from './providers/github'
import { razorpay, shopify } from './providers/simple'
import { slack } from './providers/slack'
import { stripe } from './providers/stripe'
import { svix } from './providers/svix'
import { webhook } from './route'
import { hmacBase64, hmacHex, matchesAny, timingSafeEqual } from './verify'

const opened: App[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

function make(): App {
  const app = createApp({ logger: silentLogger, development: true })
  opened.push(app)
  return app
}

const post = (app: App, body: string, headers: Record<string, string>) =>
  app.fetch(new Request('https://app.test/hook', { method: 'POST', body, headers }))

/**
 * The primitive, against a value this code did not produce.
 *
 * An expected signature computed by the implementation under test proves only that it agrees
 * with itself. GitHub publishes this triple, so it is an independent check that the HMAC, the
 * encoding and the key handling are all right.
 */
describe('the HMAC itself', () => {
  test("matches GitHub's published example", () => {
    expect(hmacHex("It's a Secret to Everybody", 'Hello, World!')).toBe(
      '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    )
  })

  test('base64 and hex are the same digest, encoded differently', () => {
    const hex = hmacHex('k', 'payload')
    const base64 = hmacBase64('k', 'payload')
    expect(Buffer.from(base64, 'base64').toString('hex')).toBe(hex)
  })
})

/** A `===` here is a timing oracle, and the attack is practical over enough requests. */
describe('comparison', () => {
  test('equal strings match', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  test('a one-character difference does not', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
  })

  test('a difference in the first byte does not', () => {
    expect(timingSafeEqual('abc123', 'zbc123')).toBe(false)
  })

  test('different lengths do not', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })

  test('matchesAny accepts a rotated secret and still rejects nonsense', () => {
    expect(matchesAny('good', ['bad', 'good'])).toBe(true)
    expect(matchesAny('good', ['bad', 'worse'])).toBe(false)
  })
})

describe('github', () => {
  const secret = 'shh'
  const body = '{"action":"opened"}'
  const sign = (payload: string) => `sha256=${hmacHex(secret, payload)}`

  test('a correct signature is accepted, and the delivery id comes through', async () => {
    const app = make()
    app.post(
      '/hook',
      webhook(github({ secret }), (ctx) => ctx.webhook),
    )

    const response = await post(app, body, {
      'x-hub-signature-256': sign(body),
      'x-github-delivery': 'delivery-1',
      'content-type': 'application/json',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      provider: 'github',
      id: 'delivery-1',
      payload: { action: 'opened' },
    })
  })

  test('a body altered after signing is refused', async () => {
    const app = make()
    app.post(
      '/hook',
      webhook(github({ secret }), () => 'ok'),
    )

    // Signed the original, sent something else — the exact attack the signature exists to stop.
    const response = await post(app, '{"action":"closed"}', { 'x-hub-signature-256': sign(body) })

    expect(response.status).toBe(401)
  })

  test('a wrong secret is refused', async () => {
    const app = make()
    app.post(
      '/hook',
      webhook(github({ secret: 'different' }), () => 'ok'),
    )

    expect((await post(app, body, { 'x-hub-signature-256': sign(body) })).status).toBe(401)
  })

  test('no signature header is a 400, not a 500', async () => {
    const app = make()
    app.post(
      '/hook',
      webhook(github({ secret }), () => 'ok'),
    )

    expect((await post(app, body, {})).status).toBe(400)
  })

  test('the handler does not run for an unverified delivery', async () => {
    let ran = false
    const app = make()
    app.post(
      '/hook',
      webhook(github({ secret }), () => {
        ran = true
        return 'ok'
      }),
    )

    await post(app, body, { 'x-hub-signature-256': 'sha256=deadbeef' })
    expect(ran).toBe(false)
  })
})

describe('stripe', () => {
  const secret = 'whsec_test'
  const body = '{"id":"evt_1"}'
  const header = (timestamp: number, payload = body) =>
    `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${payload}`)}`

  const now = 1_700_000_000_000

  test('a fresh delivery is accepted', async () => {
    const app = make()
    app.post(
      '/hook',
      webhook(stripe({ secret }), (ctx) => ctx.webhook),
    )

    const timestamp = Math.floor(Date.now() / 1000)
    const response = await post(app, body, { 'stripe-signature': header(timestamp) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ provider: 'stripe', timestamp })
  })

  /** The timestamp is inside the signed string, so it cannot be moved without breaking it. */
  test('a replayed delivery outside the window is refused', () => {
    const old = Math.floor(now / 1000) - 3600
    const result = stripe({ secret }).verify({
      body,
      headers: new Headers({ 'stripe-signature': header(old) }),
      now,
    })

    expect(result).toMatchObject({ ok: false, reason: 'timestamp-outside-tolerance' })
  })

  test('the same delivery inside the window is fine', () => {
    const recent = Math.floor(now / 1000) - 60
    expect(
      stripe({ secret }).verify({
        body,
        headers: new Headers({ 'stripe-signature': header(recent) }),
        now,
      }),
    ).toMatchObject({ ok: true })
  })

  /**
   * Moving the timestamp forward to escape the window has to invalidate the signature, or the
   * replay window is decoration.
   */
  test('a forward-dated timestamp does not rescue an old signature', () => {
    const old = Math.floor(now / 1000) - 3600
    const signature = hmacHex(secret, `${old}.${body}`)
    const fresh = Math.floor(now / 1000)

    const result = stripe({ secret }).verify({
      body,
      headers: new Headers({ 'stripe-signature': `t=${fresh},v1=${signature}` }),
      now,
    })

    expect(result).toMatchObject({ ok: false, reason: 'signature-mismatch' })
  })

  test('several v1 values are all considered, for a rotation', () => {
    const timestamp = Math.floor(now / 1000)
    const good = hmacHex(secret, `${timestamp}.${body}`)

    expect(
      stripe({ secret }).verify({
        body,
        headers: new Headers({ 'stripe-signature': `t=${timestamp},v1=old,v1=${good}` }),
        now,
      }),
    ).toMatchObject({ ok: true })
  })

  test('a header with no t= is malformed, not a mismatch', () => {
    expect(
      stripe({ secret }).verify({ body, headers: new Headers({ 'stripe-signature': 'v1=abc' }) }),
    ).toMatchObject({ ok: false, reason: 'malformed-header' })
  })
})

describe('slack', () => {
  const secret = 'slack-secret'
  const body = 'token=x&team_id=T1'
  const now = 1_700_000_000_000

  test('signs the v0 prefixed string, not the bare body', () => {
    const timestamp = Math.floor(now / 1000)
    // The construction is `v0:${ts}:${body}` — signing the body alone is the usual mistake.
    const signature = `v0=${hmacHex(secret, `v0:${timestamp}:${body}`)}`

    expect(
      slack({ secret }).verify({
        body,
        headers: new Headers({
          'x-slack-signature': signature,
          'x-slack-request-timestamp': String(timestamp),
        }),
        now,
      }),
    ).toMatchObject({ ok: true })
  })

  test('a signature over the bare body is refused', () => {
    const timestamp = Math.floor(now / 1000)

    expect(
      slack({ secret }).verify({
        body,
        headers: new Headers({
          'x-slack-signature': `v0=${hmacHex(secret, body)}`,
          'x-slack-request-timestamp': String(timestamp),
        }),
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'signature-mismatch' })
  })

  test('an old request is refused', () => {
    const stale = Math.floor(now / 1000) - 3600

    expect(
      slack({ secret }).verify({
        body,
        headers: new Headers({
          'x-slack-signature': `v0=${hmacHex(secret, `v0:${stale}:${body}`)}`,
          'x-slack-request-timestamp': String(stale),
        }),
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'timestamp-outside-tolerance' })
  })
})

describe('svix (Clerk, Resend and everything else on it)', () => {
  // Real shape: `whsec_` then base64. The *decoded bytes* are the key.
  const secret = `whsec_${Buffer.from('a-signing-key').toString('base64')}`
  const key = Buffer.from('a-signing-key')
  const body = '{"type":"user.created"}'
  const now = 1_700_000_000_000

  const headers = (id: string, timestamp: number, signature: string) =>
    new Headers({ 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': signature })

  test('a correct delivery is accepted and carries its id', () => {
    const timestamp = Math.floor(now / 1000)
    const signature = hmacBase64(key, `msg_1.${timestamp}.${body}`)

    expect(
      svix({ secret }).verify({
        body,
        headers: headers('msg_1', timestamp, `v1,${signature}`),
        now,
      }),
    ).toMatchObject({ ok: true, id: 'msg_1', timestamp })
  })

  /** The mistake that makes every signature wrong while looking correct. */
  test('using the secret as a string rather than decoding it does not verify', () => {
    const timestamp = Math.floor(now / 1000)
    const wrong = hmacBase64(secret, `msg_1.${timestamp}.${body}`)

    expect(
      svix({ secret }).verify({ body, headers: headers('msg_1', timestamp, `v1,${wrong}`), now }),
    ).toMatchObject({ ok: false, reason: 'signature-mismatch' })
  })

  test('a space-separated list is searched, so a rotation still verifies', () => {
    const timestamp = Math.floor(now / 1000)
    const good = hmacBase64(key, `msg_1.${timestamp}.${body}`)

    expect(
      svix({ secret }).verify({
        body,
        headers: headers('msg_1', timestamp, `v1,previous v1,${good}`),
        now,
      }),
    ).toMatchObject({ ok: true })
  })

  test('the id is part of the signed string, so swapping it is refused', () => {
    const timestamp = Math.floor(now / 1000)
    const signature = hmacBase64(key, `msg_1.${timestamp}.${body}`)

    expect(
      svix({ secret }).verify({
        body,
        headers: headers('msg_2', timestamp, `v1,${signature}`),
        now,
      }),
    ).toMatchObject({ ok: false, reason: 'signature-mismatch' })
  })
})

describe('razorpay and shopify', () => {
  const body = '{"event":"payment.captured"}'

  test('razorpay is hex', () => {
    expect(
      razorpay({ secret: 'rzp' }).verify({
        body,
        headers: new Headers({ 'x-razorpay-signature': hmacHex('rzp', body) }),
      }),
    ).toMatchObject({ ok: true })
  })

  /** Shopify is base64 where Razorpay is hex — the same digest, and not interchangeable. */
  test('shopify is base64, and the hex of the same digest is refused', () => {
    const verifier = shopify({ secret: 'shop' })

    expect(
      verifier.verify({
        body,
        headers: new Headers({ 'x-shopify-hmac-sha256': hmacBase64('shop', body) }),
      }),
    ).toMatchObject({ ok: true })

    expect(
      verifier.verify({
        body,
        headers: new Headers({ 'x-shopify-hmac-sha256': hmacHex('shop', body) }),
      }),
    ).toMatchObject({ ok: false, reason: 'signature-mismatch' })
  })

  test('both declare that they cannot detect a replay', () => {
    expect(razorpay({ secret: 'x' }).replayProtected).toBe(false)
    expect(shopify({ secret: 'x' }).replayProtected).toBe(false)
    expect(stripe({ secret: 'x' }).replayProtected).toBe(true)
  })
})

describe('the route', () => {
  const secret = 'shh'
  const body = '{"ok":true}'
  const sign = () => `sha256=${hmacHex(secret, body)}`

  test('the parsed payload comes from the bytes that were verified', async () => {
    const app = make()
    app.post(
      '/hook',
      webhook(github({ secret }), (ctx) => ({
        payload: ctx.webhook.payload,
        raw: ctx.webhook.raw,
      })),
    )

    const response = await post(app, body, { 'x-hub-signature-256': sign() })

    expect(await response.json()).toEqual({ payload: { ok: true }, raw: body })
  })

  test('onRejected sees the failure, because a silently failing webhook is invisible', async () => {
    const failures: string[] = []
    const app = make()
    app.post(
      '/hook',
      webhook(github({ secret }), () => 'ok', {
        onRejected: (failure) => failures.push(failure.reason),
      }),
    )

    await post(app, body, { 'x-hub-signature-256': 'sha256=nope' })
    await post(app, body, {})

    expect(failures).toEqual(['signature-mismatch', 'missing-header'])
  })

  test('a verified delivery whose body is not JSON says so distinctly', async () => {
    const app = make()
    app.post(
      '/hook',
      webhook(github({ secret: 'k' }), () => 'ok'),
    )

    const raw = 'not json'
    const response = await post(app, raw, {
      'x-hub-signature-256': `sha256=${hmacHex('k', raw)}`,
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('not JSON')
  })
})
