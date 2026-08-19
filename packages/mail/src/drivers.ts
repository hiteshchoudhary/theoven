import { assertSendable, type MailDriver, MailError, type Message, recipients } from './types'

/**
 * Prints messages to the terminal instead of sending them.
 *
 * The default, and the reason password reset works the moment `oven create` finishes: a
 * developer copies the link out of their terminal, with no provider account and no API key.
 * Laravel and Rails both ship the equivalent for the same reason.
 */
export function consoleMail(options: { from?: string } = {}): MailDriver {
  return {
    name: 'console',
    send: async (message) => {
      assertSendable(message, 'console')

      const lines = [
        '',
        '─────────────────────────────────────────────',
        `  To:      ${recipients(message.to).join(', ')}`,
        `  From:    ${message.from ?? options.from ?? 'oven@localhost'}`,
        `  Subject: ${message.subject}`,
        '─────────────────────────────────────────────',
        message.text ?? stripHtml(message.html ?? ''),
        '─────────────────────────────────────────────',
        '',
      ]
      console.log(lines.join('\n'))

      return { driver: 'console' }
    },
  }
}

/**
 * Collects messages in memory instead of sending them.
 *
 * For tests. `sent` is the whole point: asserting that a reset email went to the right address
 * is how you test a reset flow without a mail server.
 */
export function memoryMail(): MailDriver & { sent: Message[]; clear(): void } {
  const sent: Message[] = []

  return {
    name: 'memory',
    sent,
    clear: () => {
      sent.length = 0
    },
    send: async (message) => {
      assertSendable(message, 'memory')
      sent.push(message)
      return { driver: 'memory', id: String(sent.length) }
    },
  }
}

export interface ResendOptions {
  apiKey: string
  /** Default sender, e.g. `Acme <hello@acme.com>`. Resend requires a verified domain. */
  from: string
}

/**
 * Sends through Resend's HTTP API.
 *
 * HTTP rather than SMTP: no connection pool to manage, no port blocked by a host, and failures
 * come back as a status code rather than a protocol error.
 */
export function resendMail(options: ResendOptions): MailDriver {
  if (!options.apiKey) throw new MailError('Resend needs an API key.', { driver: 'resend' })

  return {
    name: 'resend',
    send: async (message) => {
      assertSendable(message, 'resend')

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from ?? options.from,
          to: recipients(message.to),
          subject: message.subject,
          ...(message.text ? { text: message.text } : {}),
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.cc ? { cc: recipients(message.cc) } : {}),
          ...(message.bcc ? { bcc: recipients(message.bcc) } : {}),
        }),
      })

      if (!response.ok) {
        // The body carries Resend's own explanation, which is more useful than the status
        // alone. The API key is in a header, so it is not in what we read back.
        const detail = await response.text().catch(() => '')
        throw new MailError(`Resend rejected the message (${response.status}). ${detail}`.trim(), {
          driver: 'resend',
        })
      }

      const body = (await response.json()) as { id?: string }
      return { driver: 'resend', ...(body.id ? { id: body.id } : {}) }
    },
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
