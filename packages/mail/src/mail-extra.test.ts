import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, silentLogger } from '@theoven/core'
import { mail } from './brick'
import { memoryMail } from './drivers'
import { createInbox, renderInbox, renderMessage } from './preview'
import { sesMail, toMime } from './ses'
import { signRequest } from './sigv4'
import { smtpMail } from './smtp'
import { defineTemplate, escapeHtml, renderTemplate, textFromHtml } from './template'
import { encodeAttachment, type Message } from './types'

const opened: Array<{ close(options?: { timeout?: number }): Promise<void> }> = []
const listening: Array<{ stop(): void }> = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close({ timeout: 0 })))
  for (const server of listening.splice(0)) server.stop()
})

// ---------------------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------------------

/**
 * Checked against AWS's own published test vectors rather than against itself.
 *
 * A signature implementation that only agrees with its own tests is a signature implementation
 * that agrees with nothing. These are the fixed inputs and expected outputs from the AWS
 * SigV4 test suite.
 */
describe('SigV4', () => {
  const CREDENTIALS = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    now: new Date('2015-08-30T12:36:00Z'),
  }

  test("it reproduces AWS's get-vanilla vector exactly", () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      body: '',
      ...CREDENTIALS,
    })

    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
  })

  test('a different body produces a different signature', () => {
    const sign = (body: string) =>
      signRequest({
        method: 'POST',
        url: new URL('https://example.amazonaws.com/'),
        headers: {},
        body,
        ...CREDENTIALS,
      }).authorization

    expect(sign('{"a":1}')).not.toBe(sign('{"a":2}'))
  })

  test('the payload hash is published as a header', () => {
    const headers = signRequest({
      method: 'POST',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      body: '',
      ...CREDENTIALS,
    })
    // SHA-256 of the empty string.
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  test('a session token is signed, not merely attached', () => {
    const base = {
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      body: '',
    }
    const without = signRequest({ ...base, ...CREDENTIALS })
    const with_ = signRequest({ ...base, ...CREDENTIALS, sessionToken: 'session-token' })

    expect(with_['x-amz-security-token']).toBe('session-token')
    expect(with_.authorization).not.toBe(without.authorization)
    expect(with_.authorization).toContain('x-amz-security-token')
  })

  test('the secret never appears in what gets sent', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      body: '',
      ...CREDENTIALS,
    })
    expect(JSON.stringify(headers)).not.toContain(CREDENTIALS.secretAccessKey)
  })
})

// ---------------------------------------------------------------------------------------
// SES
// ---------------------------------------------------------------------------------------

describe('SES driver', () => {
  function capture() {
    const requests: Array<{ url: string; headers: Headers; body: string }> = []
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers as Record<string, string>),
        body: String(init?.body ?? ''),
      })
      return new Response(JSON.stringify({ MessageId: 'ses-1' }), { status: 200 })
    }) as unknown as typeof fetch
    return { requests, fetcher }
  }

  test('credentials are required, and the message says where to put them', () => {
    expect(() =>
      sesMail({ from: 'a@b.com', accessKeyId: '', secretAccessKey: '', region: 'us-east-1' }),
    ).toThrow(/AWS_ACCESS_KEY_ID/)
  })

  test('a missing from address is refused at construction', () => {
    expect(() => sesMail({ from: '' })).toThrow(/verified `from`/)
  })

  test('it posts a signed request to the regional endpoint', async () => {
    const { requests, fetcher } = capture()
    const driver = sesMail({
      from: 'hello@acme.com',
      region: 'eu-west-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      fetcher,
    })

    const sent = await driver.send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' })

    expect(sent.id).toBe('ses-1')
    expect(requests[0]?.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails')
    expect(requests[0]?.headers.get('authorization')).toContain('AWS4-HMAC-SHA256')
    expect(requests[0]?.headers.get('authorization')).toContain('/eu-west-1/ses/')
  })

  test('a plain message uses the Simple form, which SES builds MIME for', async () => {
    const { requests, fetcher } = capture()
    const driver = sesMail({
      from: 'hello@acme.com',
      accessKeyId: 'k',
      secretAccessKey: 's',
      fetcher,
    })

    await driver.send({
      to: ['ada@example.com', 'grace@example.com'],
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      replyTo: 'support@acme.com',
      subject: 'Hi',
      html: '<p>Hello</p>',
    })

    const body = JSON.parse(requests[0]?.body ?? '{}')
    expect(body.Destination.ToAddresses).toEqual(['ada@example.com', 'grace@example.com'])
    expect(body.Destination.CcAddresses).toEqual(['cc@example.com'])
    expect(body.Destination.BccAddresses).toEqual(['bcc@example.com'])
    expect(body.ReplyToAddresses).toEqual(['support@acme.com'])
    expect(body.Content.Simple.Body.Html.Data).toBe('<p>Hello</p>')
    expect(body.Content.Raw).toBeUndefined()
  })

  // SES's Simple content has nowhere to put a file, so an attachment forces raw MIME.
  test('an attachment switches to the Raw form', async () => {
    const { requests, fetcher } = capture()
    const driver = sesMail({
      from: 'hello@acme.com',
      accessKeyId: 'k',
      secretAccessKey: 's',
      fetcher,
    })

    await driver.send({
      to: 'ada@example.com',
      subject: 'Invoice',
      text: 'Attached.',
      attachments: [{ filename: 'invoice.pdf', content: 'PDF BYTES', type: 'application/pdf' }],
    })

    const body = JSON.parse(requests[0]?.body ?? '{}')
    expect(body.Content.Simple).toBeUndefined()

    const mime = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8')
    expect(mime).toContain('Content-Type: multipart/mixed')
    expect(mime).toContain('filename="invoice.pdf"')
  })

  test("SES's own explanation is passed through, not just the status", async () => {
    const fetcher = (async () =>
      new Response('{"message":"Email address is not verified"}', {
        status: 400,
      })) as unknown as typeof fetch
    const driver = sesMail({ from: 'a@b.com', accessKeyId: 'k', secretAccessKey: 's', fetcher })

    expect(driver.send({ to: 'x@y.com', subject: 'Hi', text: 'Hi' })).rejects.toThrow(
      /not verified/,
    )
  })
})

// ---------------------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------------------

describe('MIME assembly', () => {
  test('both bodies become a multipart/alternative', async () => {
    const mime = await toMime(
      { to: 'ada@example.com', subject: 'Hi', text: 'plain', html: '<p>rich</p>' },
      'hello@acme.com',
    )

    expect(mime).toContain('Content-Type: multipart/alternative')
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8')
    expect(
      Buffer.from(
        /text\/plain[\s\S]*?\r\n\r\n([A-Za-z0-9+/=]+)/.exec(mime)?.[1] ?? '',
        'base64',
      ).toString(),
    ).toBe('plain')
  })

  // Otherwise it arrives as mojibake.
  test('a non-ASCII subject is encoded-word wrapped', async () => {
    const mime = await toMime({ to: 'a@b.com', subject: 'Über café ☕', text: 'x' }, 'f@g.com')
    expect(mime).toContain('Subject: =?UTF-8?B?')
    expect(mime).not.toContain('Subject: Über')
  })

  test('an ASCII subject is left alone', async () => {
    const mime = await toMime({ to: 'a@b.com', subject: 'Plain subject', text: 'x' }, 'f@g.com')
    expect(mime).toContain('Subject: Plain subject')
  })

  test('bcc is never written into the message', async () => {
    const mime = await toMime(
      { to: 'a@b.com', bcc: 'secret@example.com', subject: 'Hi', text: 'x' },
      'f@g.com',
    )
    // The whole meaning of blind: the recipient's copy must not name them.
    expect(mime).not.toContain('secret@example.com')
  })

  test('an inline attachment gets a Content-ID', async () => {
    const mime = await toMime(
      {
        to: 'a@b.com',
        subject: 'Hi',
        html: '<img src="cid:logo">',
        attachments: [{ filename: 'logo.png', content: 'PNG', cid: 'logo', type: 'image/png' }],
      },
      'f@g.com',
    )
    expect(mime).toContain('Content-ID: <logo>')
    expect(mime).toContain('Content-Disposition: inline')
  })

  // RFC 2045 caps *encoded content* lines at 76, not headers — a boundary header is longer
  // than that and legitimately so.
  test('base64 content is wrapped at 76 characters, as RFC 2045 requires', async () => {
    const mime = await toMime({ to: 'a@b.com', subject: 'Hi', text: 'x'.repeat(500) }, 'f@g.com')

    const encoded = mime.split('\r\n').filter((line) => /^[A-Za-z0-9+/]{20,}={0,2}$/.test(line))
    expect(encoded.length).toBeGreaterThan(1)
    for (const line of encoded) expect(line.length).toBeLessThanOrEqual(76)
  })
})

describe('attachments', () => {
  test('a Blob is read and base64 encoded, keeping its own type', async () => {
    const encoded = await encodeAttachment({
      filename: 'note.txt',
      content: new Blob(['hello'], { type: 'text/plain' }),
    })
    expect(encoded.type).toContain('text/plain')
    expect(Buffer.from(encoded.content, 'base64').toString()).toBe('hello')
  })

  test('bytes and strings work too', async () => {
    const fromBytes = await encodeAttachment({
      filename: 'a.bin',
      content: new Uint8Array([1, 2, 3]),
    })
    expect(Buffer.from(fromBytes.content, 'base64')).toEqual(Buffer.from([1, 2, 3]))

    const fromString = await encodeAttachment({ filename: 'a.txt', content: 'text' })
    expect(Buffer.from(fromString.content, 'base64').toString()).toBe('text')
  })

  test('a nameless attachment is refused before it reaches a provider', async () => {
    const app = createApp({ logger: silentLogger, development: true }).use(mail(memoryMail()))
    opened.push(app)
    app.post('/x', (ctx) =>
      ctx.mail.send({
        to: 'a@b.com',
        subject: 'Hi',
        text: 'x',
        attachments: [{ filename: '', content: 'x' }],
      }),
    )
    await app.ready()

    expect((await app.fetch(new Request('https://theoven.app/x', { method: 'POST' }))).status).toBe(
      500,
    )
  })
})

// ---------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------

describe('templates', () => {
  const welcome = defineTemplate<{ name: string; link: string }>((props) => ({
    subject: `Welcome, ${props.name}`,
    html: `<h1>Hi ${escapeHtml(props.name)}</h1><a href="${props.link}">Confirm</a>`,
  }))

  test('a template supplies the subject and body', () => {
    const message = renderTemplate({
      to: 'ada@example.com',
      template: welcome,
      props: { name: 'Ada', link: 'https://acme.com/x' },
    })

    expect(message.subject).toBe('Welcome, Ada')
    expect(message.html).toContain('Hi Ada')
    expect(message.to).toBe('ada@example.com')
  })

  // A user's name goes into an HTML body, so this is the escape that has to be there.
  test('escapeHtml neutralises injected markup', () => {
    const message = renderTemplate({
      to: 'a@b.com',
      template: welcome,
      props: { name: '<script>alert(1)</script>', link: '#' },
    })
    expect(message.html).not.toContain('<script>')
    expect(message.html).toContain('&lt;script&gt;')
  })

  test('sendTemplate goes through the driver with everything filled in', async () => {
    const driver = memoryMail()
    const app = createApp({ logger: silentLogger, development: true }).use(
      mail(driver, { from: 'hello@acme.com' }),
    )
    opened.push(app)
    app.post('/welcome', (ctx) =>
      ctx.mail.sendTemplate({
        to: 'ada@example.com',
        template: welcome,
        props: { name: 'Ada', link: 'https://acme.com/confirm' },
      }),
    )
    await app.ready()

    await app.fetch(new Request('https://theoven.app/welcome', { method: 'POST' }))

    expect(driver.sent[0]?.subject).toBe('Welcome, Ada')
    expect(driver.sent[0]?.from).toBe('hello@acme.com')
  })

  /**
   * A message with no text part scores worse with spam filters and is unreadable in a client
   * that refuses HTML. Deriving one is strictly better than sending none.
   */
  test('a text part is derived when only html is given', async () => {
    const driver = memoryMail()
    const app = createApp({ logger: silentLogger, development: true }).use(mail(driver))
    opened.push(app)
    app.post('/x', (ctx) =>
      ctx.mail.send({
        to: 'a@b.com',
        subject: 'Hi',
        html: '<p>Hello there</p><a href="https://acme.com/reset">Reset</a>',
      }),
    )
    await app.ready()

    await app.fetch(new Request('https://theoven.app/x', { method: 'POST' }))

    const text = driver.sent[0]?.text ?? ''
    expect(text).toContain('Hello there')
    // A link with no URL is a dead end in a text-only client.
    expect(text).toContain('https://acme.com/reset')
    expect(text).not.toContain('<p>')
  })

  test('an explicit text part is left alone', async () => {
    const driver = memoryMail()
    const app = createApp({ logger: silentLogger, development: true }).use(mail(driver))
    opened.push(app)
    app.post('/x', (ctx) =>
      ctx.mail.send({ to: 'a@b.com', subject: 'Hi', text: 'mine', html: '<p>theirs</p>' }),
    )
    await app.ready()

    await app.fetch(new Request('https://theoven.app/x', { method: 'POST' }))
    expect(driver.sent[0]?.text).toBe('mine')
  })

  test('textFromHtml drops scripts and styles rather than inlining them', () => {
    const text = textFromHtml('<style>.a{color:red}</style><script>alert(1)</script><p>Body</p>')
    expect(text).toBe('Body')
  })
})

// ---------------------------------------------------------------------------------------
// Preview inbox
// ---------------------------------------------------------------------------------------

describe('preview inbox', () => {
  function withPreview(development = true, options = {}) {
    const driver = memoryMail()
    const app = createApp({ logger: silentLogger, development }).use(mail(driver, options))
    opened.push(app)
    app.post('/send', (ctx) =>
      ctx.mail.send({ to: 'ada@example.com', subject: 'Reset your password', text: 'link here' }),
    )
    return { app, driver }
  }

  test('it is mounted in development and lists what was sent', async () => {
    const { app } = withPreview()
    await app.ready()
    await app.fetch(new Request('https://theoven.app/send', { method: 'POST' }))

    const page = await app.fetch(new Request('https://theoven.app/_oven/mail'))
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')

    const body = await page.text()
    expect(body).toContain('Reset your password')
    expect(body).toContain('ada@example.com')
  })

  test('a message page shows the body', async () => {
    const { app } = withPreview()
    await app.ready()
    await app.fetch(new Request('https://theoven.app/send', { method: 'POST' }))

    const list = await (await app.fetch(new Request('https://theoven.app/_oven/mail'))).text()
    const id = /_oven\/mail\/([0-9a-f-]{36})/.exec(list)?.[1]
    expect(id).toBeTruthy()

    const detail = await app.fetch(new Request(`https://theoven.app/_oven/mail/${id}`))
    expect(await detail.text()).toContain('link here')
  })

  test('an unknown message is a 404, not a crash', async () => {
    const { app } = withPreview()
    await app.ready()
    const response = await app.fetch(
      new Request('https://theoven.app/_oven/mail/00000000-0000-0000-0000-000000000000'),
    )
    expect(response.status).toBe(404)
  })

  /**
   * The inbox holds password-reset links. An unauthenticated page serving them in production
   * would be a way to take over accounts, so it is off unless someone asks for it.
   */
  test('it is off outside development', async () => {
    const { app } = withPreview(false)
    await app.ready()
    expect((await app.fetch(new Request('https://theoven.app/_oven/mail'))).status).toBe(404)
  })

  test('it can be turned off in development, and moved', async () => {
    const off = withPreview(true, { preview: false })
    await off.app.ready()
    expect((await off.app.fetch(new Request('https://theoven.app/_oven/mail'))).status).toBe(404)

    const moved = withPreview(true, { preview: '/dev/inbox' })
    await moved.app.ready()
    await moved.app.fetch(new Request('https://theoven.app/send', { method: 'POST' }))
    expect((await moved.app.fetch(new Request('https://theoven.app/dev/inbox'))).status).toBe(200)
  })

  test('it is bounded, so a long-running dev server does not leak', () => {
    const inbox = createInbox(3)
    for (const index of [1, 2, 3, 4, 5]) {
      inbox.record({ to: 'a@b.com', subject: `Message ${index}`, text: 'x' }, 'memory')
    }

    expect(inbox.all()).toHaveLength(3)
    // Newest first.
    expect(inbox.all()[0]?.subject).toBe('Message 5')
  })

  /**
   * A preview renders whatever an email contains, and some of that comes from users — a reset
   * email carries a name someone chose. Injecting it into the page would make the developer's
   * own inbox the vulnerability.
   */
  test('a hostile message body cannot script the inbox page', () => {
    const inbox = createInbox()
    const recorded = inbox.record(
      {
        to: '<img src=x onerror=alert(1)>',
        subject: '</title><script>alert(1)</script>',
        html: '<script>alert("body")</script>',
      },
      'memory',
    )

    const list = renderInbox(inbox.all(), '/_oven/mail')
    // Escaped text still contains the characters; what must not survive is a tag.
    expect(list).not.toContain('<script>alert(1)</script>')
    expect(list).not.toContain('<img src=x')
    expect(list).toContain('&lt;img src=x onerror=alert(1)&gt;')

    const detail = renderMessage(recorded, '/_oven/mail')
    // The HTML body is rendered — inside a sandboxed iframe, escaped into an attribute.
    expect(detail).toContain('<iframe sandbox srcdoc=')
    expect(detail).not.toContain('<script>alert("body")</script>')
  })
})

// ---------------------------------------------------------------------------------------
// SMTP, against a fake server in this process
// ---------------------------------------------------------------------------------------

/**
 * A minimal SMTP server, so the driver's actual conversation is tested.
 *
 * Speaking the protocol to something is the only way to know the driver speaks it. This one
 * records every command it receives, which is what the assertions read.
 */
function fakeSmtp(options: { requireAuth?: boolean; offerStartTls?: boolean } = {}) {
  const received: string[] = []
  let body = ''

  const server = Bun.listen<{ inData: boolean }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        socket.data = { inData: false }
        socket.write('220 fake.smtp ESMTP\r\n')
      },
      data: (socket, chunk) => {
        const text = chunk.toString()
        const state = socket.data

        if (state.inData) {
          body += text
          if (body.includes('\r\n.\r\n') || body.endsWith('\r\n.')) {
            state.inData = false
            received.push('<DATA>')
            socket.write('250 2.0.0 Ok: queued as ABC123\r\n')
          }
          return
        }

        for (const line of text.split('\r\n').filter(Boolean)) {
          received.push(line)
          const command = line.split(' ')[0]?.toUpperCase()

          if (command === 'EHLO') {
            const extensions = ['250-fake.smtp', '250-AUTH PLAIN LOGIN']
            if (options.offerStartTls) extensions.push('250-STARTTLS')
            extensions.push('250 SIZE 10240000')
            socket.write(`${extensions.join('\r\n')}\r\n`)
          } else if (command === 'AUTH') {
            socket.write('235 2.7.0 Authentication successful\r\n')
          } else if (command === 'MAIL' || command === 'RCPT') {
            socket.write('250 2.1.0 Ok\r\n')
          } else if (command === 'DATA') {
            state.inData = true
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
          } else if (command === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n')
            socket.end()
          } else {
            socket.write('250 2.0.0 Ok\r\n')
          }
        }
      },
    },
  })

  listening.push(server)
  return { port: server.port, received, sent: () => body }
}

describe('SMTP driver', () => {
  test('a host and a from address are required', () => {
    expect(() => smtpMail({ host: '', from: 'a@b.com' })).toThrow(/host/)
    expect(() => smtpMail({ host: 'localhost', from: '' })).toThrow(/from/)
  })

  test('it holds the whole conversation and reports the queue id', async () => {
    const server = fakeSmtp()
    const driver = smtpMail({ host: '127.0.0.1', port: server.port, from: 'hello@acme.com' })

    const sent = await driver.send({
      to: 'ada@example.com',
      subject: 'Hi',
      text: 'Hello there',
    })

    expect(sent.driver).toBe('smtp')
    expect(sent.id).toBe('ABC123')
    expect(server.received).toContain('EHLO acme.com')
    expect(server.received).toContain('MAIL FROM:<hello@acme.com>')
    expect(server.received).toContain('RCPT TO:<ada@example.com>')
    expect(server.received).toContain('DATA')
    expect(server.received).toContain('<DATA>')
  })

  test('cc and bcc each get an RCPT TO', async () => {
    const server = fakeSmtp()
    const driver = smtpMail({ host: '127.0.0.1', port: server.port, from: 'hello@acme.com' })

    await driver.send({
      to: 'ada@example.com',
      cc: 'grace@example.com',
      bcc: 'secret@example.com',
      subject: 'Hi',
      text: 'x',
    })

    expect(server.received).toContain('RCPT TO:<grace@example.com>')
    expect(server.received).toContain('RCPT TO:<secret@example.com>')
    // Blind means the message does not name them, not that they are not sent to.
    expect(server.sent()).not.toContain('secret@example.com')
  })

  test('a display name is stripped from the envelope', async () => {
    const server = fakeSmtp()
    const driver = smtpMail({
      host: '127.0.0.1',
      port: server.port,
      from: 'Acme Support <hello@acme.com>',
    })

    await driver.send({ to: 'Ada Lovelace <ada@example.com>', subject: 'Hi', text: 'x' })

    expect(server.received).toContain('MAIL FROM:<hello@acme.com>')
    expect(server.received).toContain('RCPT TO:<ada@example.com>')
  })

  test('AUTH PLAIN is used when credentials are given', async () => {
    const server = fakeSmtp()
    const driver = smtpMail({
      host: '127.0.0.1',
      port: server.port,
      user: 'user',
      pass: 'pass',
      from: 'hello@acme.com',
      // Plaintext auth is refused by default — the next test covers that. A local mail catcher
      // is the one case where it is deliberate.
      allowInsecureAuth: true,
    })

    await driver.send({ to: 'a@b.com', subject: 'Hi', text: 'x' })

    expect(server.received.some((line) => line.startsWith('AUTH PLAIN'))).toBe(true)
    // The password is base64, not plaintext — and it is never echoed back in any error.
    expect(server.received.join('\n')).not.toContain('pass\n')
  })

  /**
   * The one that matters. Credentials sent in the clear are credentials given away, so a server
   * that does not offer STARTTLS does not get a password.
   */
  test('a password is refused on a connection that cannot be encrypted', async () => {
    const server = fakeSmtp({ offerStartTls: false })
    const driver = smtpMail({
      host: '127.0.0.1',
      port: server.port,
      user: 'user',
      pass: 'hunter2',
      from: 'hello@acme.com',
    })

    expect(driver.send({ to: 'a@b.com', subject: 'Hi', text: 'x' })).rejects.toThrow(
      /does not offer STARTTLS/,
    )
    // And the password is not in the error, nor on the wire.
    expect(server.received.join('\n')).not.toContain('hunter2')
  })

  /**
   * A line that is exactly "." ends the DATA block. A body containing one would truncate the
   * message — and, with the right content, let a sender inject SMTP commands.
   */
  test('a lone dot in the body is stuffed rather than ending the message', async () => {
    const server = fakeSmtp()
    const driver = smtpMail({ host: '127.0.0.1', port: server.port, from: 'hello@acme.com' })

    await driver.send({
      to: 'a@b.com',
      subject: 'Hi',
      text: 'before\n.\nRCPT TO:<attacker@evil.com>\nafter',
    })

    // The body is base64 in the MIME document, so the injection cannot reach the command
    // stream at all — and the server saw no extra RCPT.
    expect(server.received.filter((line) => line.startsWith('RCPT TO'))).toHaveLength(1)
  })

  test('an unreachable host fails with a message rather than hanging', async () => {
    const driver = smtpMail({ host: '127.0.0.1', port: 1, from: 'hello@acme.com', timeout: 2 })
    expect(driver.send({ to: 'a@b.com', subject: 'Hi', text: 'x' })).rejects.toThrow()
  })
})
