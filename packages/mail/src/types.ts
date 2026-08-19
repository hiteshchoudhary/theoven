/**
 * A file sent alongside a message.
 *
 * `content` is a `Blob` or bytes rather than a base64 string: an attachment usually starts life
 * as an upload or a generated PDF, both of which are already one of these, and asking every
 * caller to base64-encode is asking them to hold the whole thing in memory as a string.
 */
export interface Attachment {
  /** Filename the recipient sees. */
  filename: string
  content: Blob | ArrayBuffer | ArrayBufferView | string
  /** Content type. Taken from a `Blob`'s own type when not given. */
  type?: string | undefined
  /**
   * Reference an inline image from the HTML body as `<img src="cid:the-id">`.
   *
   * Set this and the attachment is embedded rather than listed at the bottom.
   */
  cid?: string | undefined
}

/**
 * One message.
 *
 * Every optional field accepts `undefined` explicitly. The repo runs with
 * `exactOptionalPropertyTypes`, under which `{ replyTo?: string }` rejects
 * `{ replyTo: config.replyTo }` when that value is `string | undefined` — which is the normal
 * shape of configuration. Making callers write a conditional spread to satisfy the framework is
 * the framework's problem, not theirs.
 */
export interface Message {
  to: string | string[]
  subject: string
  /** At least one of `text` or `html` is required — unless a `template` supplies them. */
  text?: string | undefined
  html?: string | undefined
  from?: string | undefined
  replyTo?: string | undefined
  cc?: string | string[] | undefined
  bcc?: string | string[] | undefined
  attachments?: Attachment[] | undefined
  /**
   * Headers to set verbatim, e.g. `{ 'X-Entity-Ref-ID': id }` to stop Gmail threading.
   *
   * Not every driver honours every header; the console and memory drivers record them.
   */
  headers?: Record<string, string> | undefined
}

export interface SentMessage {
  /** Provider's id for the message, when it gives one. */
  id?: string | undefined
  /** Which driver sent it, for logs. */
  driver: string
}

/**
 * What a mail driver must do.
 *
 * One method. Templating, queueing and retries are the brick's business or the caller's, not
 * something every driver should reimplement.
 */
export interface MailDriver {
  readonly name: string
  send(message: Message): Promise<SentMessage>
  close?(): Promise<void> | void
}

/** Raised when a message cannot be sent. Never carries credentials. */
export class MailError extends Error {
  override name = 'MailError'
  readonly driver: string | undefined

  constructor(message: string, options: { driver?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.driver = options.driver
  }
}

/** Normalises a recipient list for drivers that want an array. */
export function recipients(value: string | string[] | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

/** Rejects a message that no driver could sensibly send. */
export function assertSendable(message: Message, driver: string): void {
  if (recipients(message.to).length === 0) {
    throw new MailError('A message needs at least one recipient.', { driver })
  }
  if (!message.subject) {
    throw new MailError('A message needs a subject.', { driver })
  }
  if (!message.text && !message.html) {
    throw new MailError('A message needs a text or html body.', { driver })
  }
  for (const attachment of message.attachments ?? []) {
    if (!attachment.filename) {
      throw new MailError('An attachment needs a filename.', { driver })
    }
  }
}

/**
 * Reads an attachment's bytes, base64 encoded.
 *
 * Every HTTP mail API wants base64, so this is done once here rather than three times across
 * drivers — and done at send time rather than at construction, so an attachment built from a
 * `Bun.file()` is not read until the message is actually going out.
 */
export async function encodeAttachment(
  attachment: Attachment,
): Promise<{ filename: string; content: string; type: string; cid?: string }> {
  const bytes =
    attachment.content instanceof Blob
      ? await attachment.content.arrayBuffer()
      : typeof attachment.content === 'string'
        ? new TextEncoder().encode(attachment.content).buffer
        : attachment.content

  const type =
    attachment.type ??
    (attachment.content instanceof Blob && attachment.content.type
      ? attachment.content.type
      : 'application/octet-stream')

  return {
    filename: attachment.filename,
    content: Buffer.from(bytes as ArrayBuffer).toString('base64'),
    type,
    ...(attachment.cid ? { cid: attachment.cid } : {}),
  }
}
