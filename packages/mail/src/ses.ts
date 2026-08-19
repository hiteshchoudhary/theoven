import { signRequest } from './sigv4'
import {
  assertSendable,
  encodeAttachment,
  type MailDriver,
  MailError,
  type Message,
  recipients,
} from './types'

export interface SesOptions {
  /** Default sender. Must be a verified identity in SES. */
  from: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  /** SES configuration set, for per-stream event tracking. */
  configurationSet?: string
  /** Override the endpoint, e.g. for a VPC endpoint or a local fake. */
  endpoint?: string
  /** Injected in tests. Defaults to global `fetch`. */
  fetcher?: typeof fetch
}

/**
 * Amazon SES, through its v2 HTTP API.
 *
 * HTTP rather than SES's SMTP endpoint: no connection pool, no port 587 blocked by a host, and a
 * failure is a status code with a JSON explanation rather than a protocol error.
 *
 * No AWS SDK. Requests are signed with [SigV4](https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html)
 * in about eighty lines, verified against AWS's own published test vectors — acquiring the SDK's
 * dependency tree in order to send an email is a poor trade.
 *
 * ```ts
 * app.use(mail(sesMail({
 *   from: env.string('MAIL_FROM'),
 *   region: env.string('AWS_REGION', 'us-east-1'),
 * })))
 * ```
 */
export function sesMail(options: SesOptions): MailDriver {
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1'
  const accessKeyId = options.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = options.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = options.sessionToken ?? process.env.AWS_SESSION_TOKEN
  const fetcher = options.fetcher ?? fetch

  if (!options.from) {
    throw new MailError('SES needs a verified `from` address.', { driver: 'ses' })
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new MailError(
      'SES needs credentials. Pass accessKeyId and secretAccessKey, or set AWS_ACCESS_KEY_ID ' +
        'and AWS_SECRET_ACCESS_KEY — which an instance role or a secrets mount already does.',
      { driver: 'ses' },
    )
  }

  const endpoint = options.endpoint ?? `https://email.${region}.amazonaws.com`

  return {
    name: 'ses',

    send: async (message) => {
      assertSendable(message, 'ses')

      const url = new URL('/v2/email/outbound-emails', endpoint)
      const body = JSON.stringify(await payload(message, options.from, options.configurationSet))

      const headers = signRequest({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body,
        region,
        service: 'ses',
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      })

      const response = await fetcher(url, { method: 'POST', headers, body })

      if (!response.ok) {
        // SES explains itself in the body — "Email address is not verified" is the one everybody
        // hits, and the status alone does not say it. Credentials are in headers, not the body.
        const detail = await response.text().catch(() => '')
        throw new MailError(`SES rejected the message (${response.status}). ${detail}`.trim(), {
          driver: 'ses',
        })
      }

      const result = (await response.json().catch(() => ({}))) as { MessageId?: string }
      return { driver: 'ses', ...(result.MessageId ? { id: result.MessageId } : {}) }
    },
  }
}

/**
 * Builds the SES request body.
 *
 * Attachments force the `Raw` form: SES's `Simple` content has no field for them, so a message
 * with a file becomes a MIME document we assemble ourselves. Without attachments the `Simple`
 * form is used, because it is SES's own job to build correct MIME and it does it better.
 */
async function payload(
  message: Message,
  defaultFrom: string,
  configurationSet: string | undefined,
): Promise<Record<string, unknown>> {
  const destination = {
    ToAddresses: recipients(message.to),
    ...(message.cc ? { CcAddresses: recipients(message.cc) } : {}),
    ...(message.bcc ? { BccAddresses: recipients(message.bcc) } : {}),
  }

  const common = {
    FromEmailAddress: message.from ?? defaultFrom,
    Destination: destination,
    ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
    ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
  }

  if (message.attachments && message.attachments.length > 0) {
    return {
      ...common,
      Content: {
        Raw: { Data: Buffer.from(await toMime(message, defaultFrom)).toString('base64') },
      },
    }
  }

  return {
    ...common,
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: {
          ...(message.text ? { Text: { Data: message.text, Charset: 'UTF-8' } } : {}),
          ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  }
}

/** A MIME document, for the cases SES's structured form cannot express. */
export async function toMime(message: Message, defaultFrom: string): Promise<string> {
  // Fixed-length random boundaries. A boundary that appears inside a part truncates the message,
  // and 16 random bytes makes that not happen.
  const outer = `oven-${crypto.randomUUID()}`
  const inner = `oven-alt-${crypto.randomUUID()}`

  const lines: string[] = [
    `From: ${message.from ?? defaultFrom}`,
    `To: ${recipients(message.to).join(', ')}`,
    ...(message.cc ? [`Cc: ${recipients(message.cc).join(', ')}`] : []),
    ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
    // Non-ASCII subjects must be encoded-word wrapped, or they arrive as mojibake.
    `Subject: ${encodeHeader(message.subject)}`,
    'MIME-Version: 1.0',
    ...Object.entries(message.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
  ]

  if (message.text) {
    lines.push(
      `--${inner}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(message.text, 'utf8').toString('base64')),
    )
  }
  if (message.html) {
    lines.push(
      `--${inner}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(Buffer.from(message.html, 'utf8').toString('base64')),
    )
  }
  lines.push(`--${inner}--`, '')

  for (const attachment of message.attachments ?? []) {
    const encoded = await encodeAttachment(attachment)
    lines.push(
      `--${outer}`,
      `Content-Type: ${encoded.type}; name="${encoded.filename}"`,
      'Content-Transfer-Encoding: base64',
      encoded.cid
        ? `Content-Disposition: inline; filename="${encoded.filename}"`
        : `Content-Disposition: attachment; filename="${encoded.filename}"`,
      ...(encoded.cid ? [`Content-ID: <${encoded.cid}>`] : []),
      '',
      wrap(encoded.content),
    )
  }

  lines.push(`--${outer}--`, '')
  // CRLF: SMTP's line ending, and what a MIME parser expects.
  return lines.join('\r\n')
}

/** RFC 2047 encoded-word, so a non-ASCII subject survives. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** Base64 in 76-character lines, which is what RFC 2045 requires. */
function wrap(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join('\r\n')
}
