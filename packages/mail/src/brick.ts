import type { Brick, Logger } from '@theoven/core'
import { consoleMail } from './drivers'
import { createInbox, type Inbox, renderInbox, renderMessage } from './preview'
import {
  isTemplated,
  renderTemplate,
  type Template,
  type TemplatedMessage,
  textFromHtml,
} from './template'
import { type MailDriver, MailError, type Message, type SentMessage } from './types'

export interface MailOptions {
  /** Default sender, used when a message does not set one. */
  from?: string
  /**
   * Send through this driver even outside development.
   *
   * By default the console driver is refused in production: a service that silently prints
   * password-reset links to a log instead of emailing them looks healthy while nobody can
   * reset their password.
   */
  allowConsoleInProduction?: boolean
  /**
   * Mount the preview inbox. Default: on in development, off everywhere else.
   *
   * Set a string to mount it somewhere other than `/_oven/mail`. Set `false` to leave it off.
   */
  preview?: boolean | string
  /** How many messages the preview inbox keeps. Default 50. */
  previewLimit?: number
}

/** What `ctx.mail` exposes. */
export interface MailService {
  send(message: Message): Promise<SentMessage>
  /**
   * Sends through a [template](/docs/bricks/mail/#templates).
   *
   * Separate from `send` rather than an overload, because the two have genuinely different
   * shapes: a templated message must not carry its own `subject`, and a union would let one
   * through and then quietly ignore it.
   */
  sendTemplate<Props>(message: TemplatedMessage<Props>): Promise<SentMessage>
  readonly driver: string
  /** Messages the preview inbox is holding, or `undefined` when it is off. */
  readonly inbox: Inbox | undefined
}

const PREVIEW_PATH = '/_oven/mail'

/**
 * The mail brick.
 *
 * ```ts
 * app.use(mail(env.has('RESEND_API_KEY')
 *   ? resendMail({ apiKey: env.string('RESEND_API_KEY'), from: env.string('MAIL_FROM') })
 *   : consoleMail()))
 *
 * await ctx.mail.send({ to: user.email, subject: 'Hello', text: 'Hi there' })
 * ```
 *
 * Defaults to the console driver so that `oven create` produces an app where password reset
 * works immediately — the link appears in the terminal. Configuring a real provider is adding
 * environment variables, not rewriting code.
 */
export function mail(
  driver: MailDriver = consoleMail(),
  options: MailOptions = {},
): Brick<'mail', MailService> {
  return {
    name: 'mail',

    setup: (context) => {
      if (!context.development && driver.name === 'console' && !options.allowConsoleInProduction) {
        throw new MailError(
          'The console mail driver is refused in production: password-reset links would be ' +
            'printed to the log instead of emailed, and the service would look healthy while ' +
            'nobody could reset their password. Configure a real driver, or pass ' +
            'allowConsoleInProduction if you genuinely mean it.',
          { driver: 'console' },
        )
      }

      /**
       * The inbox is a development tool and is off outside development by default.
       *
       * It holds message bodies in memory, and those bodies contain password-reset links. An
       * unauthenticated page serving them in production would be a way to take over accounts,
       * so opting in has to be explicit.
       */
      const previewPath = resolvePreviewPath(options.preview, context.development)
      const inbox = previewPath ? createInbox(options.previewLimit ?? 50) : undefined

      if (previewPath && inbox) {
        if (!context.development) {
          context.app.logger.warn(
            `The mail preview inbox is mounted at ${previewPath} outside development. It serves ` +
              'message bodies, including password-reset links, to anyone who can reach it.',
          )
        }
        context.route('GET', previewPath, () => html(renderInbox(inbox.all(), previewPath)))
        context.route('GET', `${previewPath}/:id`, (ctx) => {
          const message = inbox.find(String(ctx.params.id))
          if (!message) return new Response('Not found', { status: 404 })
          return html(renderMessage(message, previewPath))
        })
      }

      async function dispatch(message: Message): Promise<SentMessage> {
        const prepared = prepare(message, options.from)
        const result = await send(driver, prepared, context.app.logger)
        inbox?.record(prepared, result.driver)
        return result
      }

      return {
        driver: driver.name,
        inbox,
        send: dispatch,
        sendTemplate: (message) => {
          if (!isTemplated(message)) {
            throw new MailError('sendTemplate needs a `template`.', { driver: driver.name })
          }
          return dispatch(renderTemplate(message))
        },
      }
    },

    onShutdown: async () => {
      await driver.close?.()
    },
  }
}

/**
 * Applies the defaults every driver would otherwise apply differently.
 *
 * The text part is derived from HTML when a message has only HTML: a message with no text part
 * scores worse with spam filters and is unreadable in a client that refuses HTML, and deriving
 * one is strictly better than sending none.
 */
function prepare(message: Message, defaultFrom: string | undefined): Message {
  const from = message.from ?? defaultFrom

  return {
    ...message,
    ...(from ? { from } : {}),
    ...(!message.text && message.html ? { text: textFromHtml(message.html) } : {}),
  }
}

function resolvePreviewPath(
  preview: boolean | string | undefined,
  development: boolean,
): string | undefined {
  if (preview === false) return undefined
  if (typeof preview === 'string') return preview.startsWith('/') ? preview : `/${preview}`
  if (preview === true) return PREVIEW_PATH
  return development ? PREVIEW_PATH : undefined
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // A development inbox that a browser cached would show yesterday's messages.
      'cache-control': 'no-store',
    },
  })
}

async function send(driver: MailDriver, message: Message, logger: Logger): Promise<SentMessage> {
  try {
    const result = await driver.send(message)
    logger.info('mail sent', { driver: result.driver, subject: message.subject })
    return result
  } catch (cause) {
    // The recipient and subject are logged; the body is not. A failed password-reset email
    // would otherwise put a working reset token into the log.
    logger.error('mail failed', {
      driver: driver.name,
      subject: message.subject,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
    throw cause
  }
}

export type { Template, TemplatedMessage }
