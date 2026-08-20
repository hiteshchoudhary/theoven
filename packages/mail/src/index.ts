export { type MailOptions, type MailService, mail } from './brick'
export { consoleMail, memoryMail, type ResendOptions, resendMail } from './drivers'
export type {
  Inbox,
  PreviewedMessage,
} from './preview'
export { type SesOptions, sesMail } from './ses'
export type { SignOptions } from './sigv4'
export { type SmtpOptions, smtpMail } from './smtp'
export {
  defineTemplate,
  escapeHtml,
  type Template,
  type TemplatedMessage,
  type TemplateResult,
} from './template'
export {
  type Attachment,
  type MailDriver,
  MailError,
  type Message,
  type SentMessage,
} from './types'
