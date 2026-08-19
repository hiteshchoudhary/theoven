import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { mail } from './brick'
import { consoleMail, memoryMail, resendMail } from './drivers'
import { assertSendable, MailError, recipients } from './types'

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 100 })))
})

const MESSAGE = { to: 'ada@example.com', subject: 'Hello', text: 'Hi there' }

describe('memory driver', () => {
  test('collects messages instead of sending them', async () => {
    const driver = memoryMail()
    await driver.send(MESSAGE)

    expect(driver.sent).toHaveLength(1)
    expect(driver.sent[0]).toMatchObject({ to: 'ada@example.com', subject: 'Hello' })
  })

  test('clear empties the outbox', async () => {
    const driver = memoryMail()
    await driver.send(MESSAGE)
    driver.clear()
    expect(driver.sent).toHaveLength(0)
  })
})

describe('console driver', () => {
  test('reports success without a provider', async () => {
    const result = await consoleMail().send(MESSAGE)
    expect(result.driver).toBe('console')
  })

  test('accepts an html-only message', async () => {
    expect(
      consoleMail().send({ to: 'a@b.co', subject: 'S', html: '<b>hi</b>' }),
    ).resolves.toBeDefined()
  })
})

describe('validation', () => {
  test.each([
    [{ to: '', subject: 'S', text: 'T' }, /recipient/],
    [{ to: 'a@b.co', subject: '', text: 'T' }, /subject/],
    [{ to: 'a@b.co', subject: 'S' }, /text or html/],
  ])('rejects %p', (message, pattern) => {
    expect(() => assertSendable(message as never, 'test')).toThrow(pattern)
  })

  test('accepts a valid message', () => {
    expect(() => assertSendable(MESSAGE, 'test')).not.toThrow()
  })

  test('recipients normalises to an array', () => {
    expect(recipients('a@b.co')).toEqual(['a@b.co'])
    expect(recipients(['a@b.co', 'c@d.co'])).toEqual(['a@b.co', 'c@d.co'])
    expect(recipients(undefined)).toEqual([])
  })
})

describe('the brick', () => {
  function make(driver = memoryMail(), development = true) {
    const app = createApp({ logger: silentLogger, development }).use(mail(driver))
    opened.push(app)
    return { app, driver }
  }

  test('exposes send on the context', async () => {
    const { app, driver } = make()
    app.post('/notify', async (ctx) => ctx.mail.send(MESSAGE))

    await app.fetch(new Request('https://theoven.app/notify', { method: 'POST' }))
    expect(driver.sent).toHaveLength(1)
  })

  test('reports which driver is in use', async () => {
    const { app } = make()
    app.get('/driver', (ctx) => ({ driver: ctx.mail.driver }))

    const response = await app.fetch(new Request('https://theoven.app/driver'))
    expect(await response.json()).toEqual({ driver: 'memory' })
  })

  test('applies a default sender', async () => {
    const driver = memoryMail()
    const app = createApp({ logger: silentLogger, development: true }).use(
      mail(driver, { from: 'Acme <hello@acme.com>' }),
    )
    opened.push(app)
    app.post('/x', async (ctx) => ctx.mail.send(MESSAGE))

    await app.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    expect(driver.sent[0]?.from).toBe('Acme <hello@acme.com>')
  })

  test('a message can override the sender', async () => {
    const driver = memoryMail()
    const app = createApp({ logger: silentLogger, development: true }).use(
      mail(driver, { from: 'default@acme.com' }),
    )
    opened.push(app)
    app.post('/x', async (ctx) => ctx.mail.send({ ...MESSAGE, from: 'specific@acme.com' }))

    await app.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    expect(driver.sent[0]?.from).toBe('specific@acme.com')
  })

  test('defaults to the console driver, so reset works with no configuration', async () => {
    const app = createApp({ logger: silentLogger, development: true }).use(mail())
    opened.push(app)
    app.get('/driver', (ctx) => ({ driver: ctx.mail.driver }))

    const response = await app.fetch(new Request('https://theoven.app/driver'))
    expect(await response.json()).toEqual({ driver: 'console' })
  })

  // A service printing reset links to a log looks healthy while nobody can reset a password.
  test('refuses the console driver in production', async () => {
    const app = createApp({ logger: silentLogger, development: false }).use(mail(consoleMail()))
    opened.push(app)
    expect(app.ready()).rejects.toThrow(/refused in production/)
  })

  test('the production refusal can be overridden deliberately', async () => {
    const app = createApp({ logger: silentLogger, development: false }).use(
      mail(consoleMail(), { allowConsoleInProduction: true }),
    )
    opened.push(app)
    expect(app.ready()).resolves.toBeUndefined()
  })

  test('a real driver is fine in production', async () => {
    const app = createApp({ logger: silentLogger, development: false }).use(mail(memoryMail()))
    opened.push(app)
    expect(app.ready()).resolves.toBeUndefined()
  })

  // A failed reset email would otherwise put a working token into the log.
  test('a failure logs the subject but never the body', async () => {
    const lines: Array<Record<string, unknown>> = []
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error(message: string, fields?: Record<string, unknown>) {
        lines.push({ message, ...fields })
      },
      child() {
        return logger
      },
    }

    const failing = {
      name: 'failing',
      send: async () => {
        throw new MailError('provider down', { driver: 'failing' })
      },
    }

    const app = createApp({ logger, development: true }).use(mail(failing))
    opened.push(app)
    app.post('/x', async (ctx) =>
      ctx.mail.send({ to: 'a@b.co', subject: 'Reset', text: 'token=SECRET-RESET-TOKEN' }),
    )

    await app.fetch(new Request('https://theoven.app/x', { method: 'POST' }))

    expect(JSON.stringify(lines)).toContain('Reset')
    expect(JSON.stringify(lines)).not.toContain('SECRET-RESET-TOKEN')
  })
})

describe('resend driver', () => {
  test('needs an API key', () => {
    expect(() => resendMail({ apiKey: '', from: 'a@b.co' })).toThrow(/API key/)
  })

  test('constructs with one', () => {
    expect(resendMail({ apiKey: 're_123', from: 'a@b.co' }).name).toBe('resend')
  })
})

describe('MailError', () => {
  test('is a real Error carrying the driver', () => {
    const error = new MailError('failed', { driver: 'resend' })
    expect(error).toBeInstanceOf(Error)
    expect(error.driver).toBe('resend')
  })
})
