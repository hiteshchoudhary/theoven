export { type MailOptions, type MailService, mail } from './brick'
export { consoleMail, memoryMail, type ResendOptions, resendMail } from './drivers'
export {
  createInbox,
  type Inbox,
  type PreviewedMessage,
  renderInbox,
  renderMessage,
} from './preview'
export { type SesOptions, sesMail, toMime } from './ses'
export { type SignOptions, signRequest } from './sigv4'
export { type SmtpOptions, smtpMail } from './smtp'
export {
  defineTemplate,
  escapeHtml,
  isTemplated,
  renderTemplate,
  type Template,
  type TemplatedMessage,
  type TemplateResult,
  textFromHtml,
} from './template'
export {
  type Attachment,
  assertSendable,
  encodeAttachment,
  type MailDriver,
  MailError,
  type Message,
  recipients,
  type SentMessage,
} from './types'
