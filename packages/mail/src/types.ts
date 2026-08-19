/** One message. */
export interface Message {
  to: string | string[]
  subject: string
  /** At least one of `text` or `html` is required. */
  text?: string
  html?: string
  from?: string
  replyTo?: string
  cc?: string | string[]
  bcc?: string | string[]
}

export interface SentMessage {
  /** Provider's id for the message, when it gives one. */
  id?: string
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
}
