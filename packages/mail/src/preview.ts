import type { Message } from './types'
import { recipients } from './types'

/** A message the preview inbox is holding, with when it was sent. */
export interface PreviewedMessage extends Message {
  id: string
  sentAt: string
  driver: string
}

/**
 * A ring buffer of recently sent messages.
 *
 * Bounded on purpose. A development inbox that grows without limit is a memory leak in the one
 * process a developer leaves running for a week.
 */
export function createInbox(limit = 50) {
  const messages: PreviewedMessage[] = []

  return {
    record(message: Message, driver: string): PreviewedMessage {
      const recorded: PreviewedMessage = {
        ...message,
        id: crypto.randomUUID(),
        sentAt: new Date().toISOString(),
        driver,
      }
      messages.unshift(recorded)
      if (messages.length > limit) messages.length = limit
      return recorded
    },
    all: () => messages,
    find: (id: string) => messages.find((message) => message.id === id),
    clear: () => {
      messages.length = 0
    },
  }
}

export type Inbox = ReturnType<typeof createInbox>

/**
 * The inbox page.
 *
 * Hand-written HTML with inline styles rather than a template engine or a bundled asset: it is a
 * development tool, it must work with no build step and no network, and it must not add a
 * dependency to a package whose job is sending email.
 */
export function renderInbox(messages: PreviewedMessage[], basePath: string): string {
  const list =
    messages.length === 0
      ? `<p class="empty">No messages yet. Send one and it will appear here.</p>`
      : messages
          .map(
            (message) => `
    <a class="row" href="${basePath}/${message.id}">
      <div class="row-main">
        <span class="subject">${escape(message.subject)}</span>
        <span class="to">${escape(recipients(message.to).join(', '))}</span>
      </div>
      <div class="row-meta">
        <span class="driver">${escape(message.driver)}</span>
        <time datetime="${message.sentAt}">${escape(message.sentAt.slice(11, 19))}</time>
      </div>
    </a>`,
          )
          .join('')

  return page(
    'Inbox',
    `<header>
      <h1>Inbox</h1>
      <p>${messages.length} message${messages.length === 1 ? '' : 's'} — development only, held in memory.</p>
    </header>
    <div class="list">${list}</div>`,
  )
}

/** One message: headers, both bodies, and any attachments. */
export function renderMessage(message: PreviewedMessage, basePath: string): string {
  const rows: Array<[string, string]> = [
    ['To', recipients(message.to).join(', ')],
    ...(message.from ? ([['From', message.from]] as Array<[string, string]>) : []),
    ...(message.cc ? ([['Cc', recipients(message.cc).join(', ')]] as Array<[string, string]>) : []),
    ...(message.bcc
      ? ([['Bcc', recipients(message.bcc).join(', ')]] as Array<[string, string]>)
      : []),
    ...(message.replyTo ? ([['Reply-To', message.replyTo]] as Array<[string, string]>) : []),
    ['Sent', message.sentAt],
    ['Driver', message.driver],
  ]

  const attachments =
    message.attachments && message.attachments.length > 0
      ? `<section><h2>Attachments</h2><ul>${message.attachments
          .map(
            (attachment) =>
              `<li>${escape(attachment.filename)}${attachment.cid ? ` <span class="cid">cid:${escape(attachment.cid)}</span>` : ''}</li>`,
          )
          .join('')}</ul></section>`
      : ''

  /**
   * The HTML body goes in a sandboxed iframe.
   *
   * A preview renders whatever an email contains, and some of that arrives from users — a
   * password-reset email carries a name someone chose. Injecting it into this page would make
   * the developer's own inbox the vulnerability. `srcdoc` with an empty `sandbox` runs no
   * script and loads nothing.
   */
  const html = message.html
    ? `<section><h2>HTML</h2><iframe sandbox srcdoc="${escape(message.html)}"></iframe></section>`
    : ''

  const text = message.text
    ? `<section><h2>Text</h2><pre>${escape(message.text)}</pre></section>`
    : ''

  return page(
    message.subject,
    `<header>
      <a class="back" href="${basePath}">← Inbox</a>
      <h1>${escape(message.subject)}</h1>
    </header>
    <table>${rows.map(([name, value]) => `<tr><th>${name}</th><td>${escape(value)}</td></tr>`).join('')}</table>
    ${html}${text}${attachments}`,
  )
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — Oven mail</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --dim: #8888; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.5rem; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif;
         max-width: 62rem; margin-inline: auto; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  header p { margin: 0; color: var(--dim); font-size: .9rem; }
  .back { color: var(--dim); text-decoration: none; font-size: .85rem; }
  .back:hover { text-decoration: underline; }
  .list { display: flex; flex-direction: column; }
  .row { display: flex; justify-content: space-between; gap: 1rem; padding: .75rem .5rem;
         border-bottom: 1px solid var(--line); text-decoration: none; color: inherit; }
  .row:hover { background: #8881; }
  .row-main { display: flex; flex-direction: column; min-width: 0; }
  .subject { font-weight: 600; }
  .to, .row-meta { color: var(--dim); font-size: .85rem; }
  .row-meta { display: flex; gap: .75rem; align-items: center; white-space: nowrap; }
  .driver { border: 1px solid var(--line); border-radius: 999px; padding: 0 .5rem; font-size: .75rem; }
  .empty { color: var(--dim); padding: 2rem 0; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; font-size: .9rem; }
  th { text-align: left; color: var(--dim); font-weight: 500; width: 7rem; padding: .25rem .5rem .25rem 0;
       vertical-align: top; }
  td { padding: .25rem 0; word-break: break-word; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--dim);
       margin: 1.5rem 0 .5rem; }
  pre { white-space: pre-wrap; word-break: break-word; background: #8881; padding: 1rem;
        border-radius: 8px; margin: 0; font-size: .875rem; }
  iframe { width: 100%; min-height: 26rem; border: 1px solid var(--line); border-radius: 8px;
           background: #fff; }
  ul { margin: 0; padding-left: 1.25rem; }
  .cid { color: var(--dim); font-size: .8rem; }
</style>
</head>
<body>${body}</body>
</html>`
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
