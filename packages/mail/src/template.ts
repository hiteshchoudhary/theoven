import type { Message } from './types'

/**
 * A typed email template.
 *
 * A **function**, not a file format. `defineTemplate` gives you the types and nothing else,
 * which is the point: a template engine here would be a second templating system to learn, a
 * build step to configure, and a class of runtime error (missing variable) that a function
 * signature already prevents at compile time.
 *
 * ```ts
 * const welcome = defineTemplate<{ name: string; link: string }>((props) => ({
 *   subject: `Welcome, ${props.name}`,
 *   text: `Confirm your address: ${props.link}`,
 *   html: layout(`<h1>Welcome, ${escapeHtml(props.name)}</h1>
 *                 <a href="${escapeHtml(props.link)}">Confirm</a>`),
 * }))
 *
 * await ctx.mail.send({ to: user.email, template: welcome, props: { name, link } })
 * ```
 *
 * If you want JSX, render it yourself and return the string — React Email and `Bun.renderToString`
 * both produce one, and this takes whatever they give you.
 */
export interface Template<Props> {
  (props: Props): TemplateResult
  /** Marks the value as a template, so `send()` can tell one from a plain message. */
  readonly __template: true
}

export interface TemplateResult {
  subject: string
  text?: string | undefined
  html?: string | undefined
}

export function defineTemplate<Props = void>(
  render: (props: Props) => TemplateResult,
): Template<Props> {
  const template = ((props: Props) => render(props)) as Template<Props>
  Object.defineProperty(template, '__template', { value: true })
  return template
}

/**
 * A message sent through a template.
 *
 * `subject`, `text` and `html` come from the template, so they are not accepted here — passing
 * both a template and a subject would raise the question of which wins, and any answer to that
 * is a thing to remember.
 */
export type TemplatedMessage<Props> = Omit<Message, 'subject' | 'text' | 'html'> & {
  template: Template<Props>
} & (Props extends void ? { props?: undefined } : { props: Props })

/** Turns a templated message into an ordinary one. */
export function renderTemplate<Props>(message: TemplatedMessage<Props>): Message {
  const { template, props, ...rest } = message as TemplatedMessage<Props> & { props: Props }
  const rendered = template(props)

  return {
    ...rest,
    subject: rendered.subject,
    ...(rendered.text ? { text: rendered.text } : {}),
    ...(rendered.html ? { html: rendered.html } : {}),
  }
}

export function isTemplated(message: unknown): message is TemplatedMessage<unknown> {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { template?: unknown }).template === 'function'
  )
}

/**
 * Escapes text for interpolation into an HTML body.
 *
 * Exported because a template is a plain function building a string, and the moment a user's
 * name goes into one, this is needed. Not providing it would mean every application writes its
 * own, and some of them would forget.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Plain text from an HTML body, for the multipart alternative.
 *
 * Used when a template gives `html` and no `text`. A message with no text part lands in spam
 * more often and is unreadable in a client that refuses HTML, so one is derived rather than
 * left absent.
 */
export function textFromHtml(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      // Links are worth keeping as text: "Confirm your address" with no URL is a dead end.
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}
