export { type MailOptions, type MailService, mail } from './brick'
export { consoleMail, memoryMail, type ResendOptions, resendMail } from './drivers'
export {
  assertSendable,
  type MailDriver,
  MailError,
  type Message,
  recipients,
  type SentMessage,
} from './types'
