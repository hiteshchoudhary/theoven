import type { Brick, Logger } from '@theoven/core'
import { consoleMail } from './drivers'
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
}

/** What `ctx.mail` exposes. */
export interface MailService {
  send(message: Message): Promise<SentMessage>
  readonly driver: string
}

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

      return {
        driver: driver.name,
        send: async (message) => {
          const withDefaults: Message = {
            ...message,
            ...((message.from ?? options.from) ? { from: message.from ?? options.from } : {}),
          }
          return send(driver, withDefaults, context.app.logger)
        },
      }
    },

    onShutdown: async () => {
      await driver.close?.()
    },
  }
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
