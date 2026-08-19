# @theoven/mail

[![npm](https://img.shields.io/npm/v/@theoven/mail)](https://www.npmjs.com/package/@theoven/mail)

> Transactional email for Oven — Resend, SES, SMTP, console and memory drivers, typed templates, and a dev preview inbox.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/mail
```

## Usage

```ts
import { mail, consoleMail, resendMail } from '@theoven/mail'

const app = createApp().use(mail(
  env.has('RESEND_API_KEY') ? resendMail({ apiKey, from }) : consoleMail(),
))

await ctx.mail.send({ to: user.email, subject: 'Welcome', html })
```

Defaults to the console driver, so password reset works the moment `oven create` finishes — the
link appears in your terminal. Read the message at `/_oven/mail` in development.

Templates are typed **functions**: miss a prop and it is a compile error, not an email reading
`Welcome, undefined`. SES is signed with SigV4 written here and checked against AWS's published
test vectors; SMTP refuses to send a password over an unencrypted connection.

## Documentation

**[https://theoven.app/docs/bricks/mail/](https://theoven.app/docs/bricks/mail/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
