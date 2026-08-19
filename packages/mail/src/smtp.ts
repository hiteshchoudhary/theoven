import { toMime } from './ses'
import { assertSendable, type MailDriver, MailError, recipients } from './types'

export interface SmtpOptions {
  host: string
  /** Default 587 (STARTTLS). Use 465 for implicit TLS, 1025 for a local Mailpit or MailHog. */
  port?: number
  /** Implicit TLS from the first byte. Inferred from port 465 when not set. */
  secure?: boolean
  user?: string
  pass?: string
  /** Default sender. */
  from: string
  /** Seconds to wait on the server. Default 30. */
  timeout?: number
  /**
   * Send credentials over an unencrypted connection.
   *
   * Refused by default, because a password on a plaintext socket is a password given away. The
   * one legitimate case is a local mail catcher — Mailpit or MailHog on `127.0.0.1` with auth
   * turned on — where there is no network to intercept and no real password.
   */
  allowInsecureAuth?: boolean
  /**
   * Accept a certificate that does not verify.
   *
   * For a local mail catcher with a self-signed certificate, and nothing else — it turns off the
   * check that stops someone else reading the credentials this connection sends.
   */
  rejectUnauthorized?: boolean
}

/**
 * SMTP, spoken directly over a socket.
 *
 * `Bun.connect` gives TLS and sockets, and the subset of SMTP a transactional sender needs is
 * small: EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA. That is what this implements — no
 * mailbox management, no pipelining, no connection pool.
 *
 * Prefer an HTTP driver where you have one. SMTP means a long-lived TCP connection, a port
 * hosting providers block, and errors that arrive as three-digit codes.
 *
 * ```ts
 * app.use(mail(smtpMail({
 *   host: env.string('SMTP_HOST'),
 *   port: env.port('SMTP_PORT', 587),
 *   user: env.string('SMTP_USER'),
 *   pass: env.string('SMTP_PASS'),
 *   from: env.string('MAIL_FROM'),
 * })))
 * ```
 */
export function smtpMail(options: SmtpOptions): MailDriver {
  if (!options.host) throw new MailError('SMTP needs a host.', { driver: 'smtp' })
  if (!options.from) throw new MailError('SMTP needs a `from` address.', { driver: 'smtp' })

  const port = options.port ?? 587
  const secure = options.secure ?? port === 465

  return {
    name: 'smtp',

    send: async (message) => {
      assertSendable(message, 'smtp')

      const session = await connect({ ...options, port, secure })

      try {
        const greeting = await session.expect(220)
        const supports = await session.ehlo(hostnameFrom(options.from))

        // STARTTLS before AUTH, always. Credentials sent in the clear on port 587 are
        // credentials given away, and a server offering STARTTLS is a server expecting it.
        if (!secure && supports.has('STARTTLS')) {
          await session.command('STARTTLS', 250, 220)
          await session.upgrade()
          await session.ehlo(hostnameFrom(options.from))
        } else if (!secure && options.pass && !options.allowInsecureAuth) {
          throw new MailError(
            `${options.host}:${port} does not offer STARTTLS, so a password would be sent in ` +
              'the clear. Use port 465, a server that supports STARTTLS, or — for a local mail ' +
              'catcher only — pass allowInsecureAuth.',
            { driver: 'smtp' },
          )
        }

        if (options.user && options.pass) {
          await session.authenticate(options.user, options.pass)
        }

        void greeting

        await session.command(`MAIL FROM:<${addressOf(message.from ?? options.from)}>`, 250)

        // Bcc recipients get an RCPT TO like anyone else; what makes them blind is that the
        // header is never written into the message.
        const everyone = [
          ...recipients(message.to),
          ...recipients(message.cc),
          ...recipients(message.bcc),
        ]
        for (const recipient of everyone) {
          await session.command(`RCPT TO:<${addressOf(recipient)}>`, 250, 251)
        }

        await session.command('DATA', 354)
        const mime = await toMime(message, options.from)
        await session.data(mime)

        const accepted = await session.expect(250)
        await session.command('QUIT', 221).catch(() => {})

        return { driver: 'smtp', ...(idFrom(accepted) ? { id: idFrom(accepted) } : {}) }
      } finally {
        session.close()
      }
    },
  }
}

// ---------------------------------------------------------------------------------------
// The socket conversation
// ---------------------------------------------------------------------------------------

interface Session {
  expect(...codes: number[]): Promise<string>
  command(line: string, ...codes: number[]): Promise<string>
  ehlo(hostname: string): Promise<Set<string>>
  authenticate(user: string, pass: string): Promise<void>
  data(body: string): Promise<void>
  upgrade(): Promise<void>
  close(): void
}

async function connect(options: SmtpOptions & { port: number; secure: boolean }): Promise<Session> {
  const timeout = (options.timeout ?? 30) * 1000

  let buffer = ''
  let waiting: ((value: string) => void) | undefined
  let failed: ((reason: Error) => void) | undefined
  let closed = false

  /**
   * A reply is complete when a line starts with three digits and a space.
   *
   * `250-SIZE` is a continuation and `250 OK` is the last line. Reading line-by-line instead
   * would return halfway through a multi-line EHLO response.
   */
  function drain(): void {
    const match = /^\d{3} [^\n]*\r?\n/m.exec(buffer)
    if (!match || !waiting) return

    const end = buffer.indexOf(match[0]) + match[0].length
    const reply = buffer.slice(0, end)
    buffer = buffer.slice(end)

    const resolve = waiting
    waiting = undefined
    resolve(reply)
  }

  const socket = await Bun.connect({
    hostname: options.host,
    port: options.port,
    ...(options.secure
      ? {
          tls: options.rejectUnauthorized === false ? { rejectUnauthorized: false } : true,
        }
      : {}),
    socket: {
      data: (_socket, chunk) => {
        buffer += chunk.toString()
        drain()
      },
      close: () => {
        closed = true
        failed?.(new MailError('The SMTP server closed the connection.', { driver: 'smtp' }))
      },
      error: (_socket, error) => {
        failed?.(new MailError(`SMTP connection failed: ${error.message}`, { driver: 'smtp' }))
      },
    },
  })

  function read(): Promise<string> {
    if (closed) {
      return Promise.reject(new MailError('The SMTP connection is closed.', { driver: 'smtp' }))
    }
    return new Promise<string>((resolve, reject) => {
      waiting = resolve
      failed = reject
      const timer = setTimeout(() => {
        waiting = undefined
        reject(
          new MailError(`${options.host} did not reply within ${timeout / 1000}s.`, {
            driver: 'smtp',
          }),
        )
      }, timeout)
      // Unref so a hung server cannot hold the process open at shutdown.
      timer.unref?.()
      drain()
    })
  }

  function write(line: string): void {
    socket.write(`${line}\r\n`)
  }

  async function expect(...codes: number[]): Promise<string> {
    const reply = await read()
    const code = Number(reply.slice(0, 3))
    if (codes.length > 0 && !codes.includes(code)) {
      throw new MailError(`SMTP server replied ${reply.trim()}`, { driver: 'smtp' })
    }
    return reply
  }

  const session: Session = {
    expect,

    command: async (line, ...codes) => {
      write(line)
      return expect(...codes)
    },

    ehlo: async (hostname) => {
      write(`EHLO ${hostname}`)
      const reply = await expect(250)
      // `250-AUTH PLAIN LOGIN` — the keyword is the first word of each line after the code.
      const keywords = new Set<string>()
      for (const line of reply.split(/\r?\n/)) {
        const rest = line.slice(4).trim()
        if (rest) keywords.add(rest.split(' ')[0]?.toUpperCase() ?? '')
        if (rest.toUpperCase().startsWith('AUTH')) {
          for (const mechanism of rest.split(/\s+/).slice(1))
            keywords.add(`AUTH ${mechanism.toUpperCase()}`)
        }
      }
      return keywords
    },

    authenticate: async (user, pass) => {
      // PLAIN in one round trip; LOGIN as the fallback for servers that only do that.
      const plain = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')
      write(`AUTH PLAIN ${plain}`)
      const reply = await read()
      if (reply.startsWith('235')) return

      write('AUTH LOGIN')
      await expect(334)
      write(Buffer.from(user, 'utf8').toString('base64'))
      await expect(334)
      write(Buffer.from(pass, 'utf8').toString('base64'))
      const second = await read()
      if (!second.startsWith('235')) {
        // Never echo the password, not even in a "we tried X" message.
        throw new MailError(`SMTP authentication failed: ${second.trim()}`, { driver: 'smtp' })
      }
    },

    data: async (body) => {
      // Dot-stuffing. A line that is exactly "." ends the DATA block, so a body containing one
      // would truncate the message — and, with the right content, let a sender inject SMTP
      // commands. Every leading dot is doubled.
      write(`${body.replace(/^\./gm, '..')}\r\n.`)
    },

    upgrade: async () => {
      // Bun's socket upgrades in place; the same handlers keep receiving data.
      await (socket as unknown as { upgradeTLS(options: unknown): Promise<unknown> }).upgradeTLS({
        tls: options.rejectUnauthorized === false ? { rejectUnauthorized: false } : true,
        hostname: options.host,
      })
    },

    close: () => {
      closed = true
      try {
        socket.end()
      } catch {
        // Already gone. Closing a closed socket is not a failure worth reporting.
      }
    },
  }

  return session
}

/** `Acme <hello@acme.com>` → `hello@acme.com`. SMTP envelopes want the bare address. */
function addressOf(value: string): string {
  const angled = /<([^>]+)>/.exec(value)
  return (angled ? angled[1] : value)?.trim() ?? value
}

/** The domain to announce in EHLO. Derived from the sender rather than invented. */
function hostnameFrom(from: string): string {
  return addressOf(from).split('@')[1] ?? 'localhost'
}

/** Many servers put a queue id in the final 250. Worth keeping when they do. */
function idFrom(reply: string): string | undefined {
  return /queued as ([A-Za-z0-9]+)/i.exec(reply)?.[1]
}
