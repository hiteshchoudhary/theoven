# @theoven/auth

[![npm](https://img.shields.io/npm/v/@theoven/auth)](https://www.npmjs.com/package/@theoven/auth)

> The auth contract for Oven — identity, route guards, named policies, and the flows every storage brick shares.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/auth @theoven/auth-basic
```

## Usage

```ts
import { auth } from '@theoven/auth'
import { basicAuth } from '@theoven/auth-basic'

const app = createApp().use(auth(basicAuth({ db: client, secret })))

app.get('/me', { auth: true }, (ctx) => ctx.user)   // ctx.user is non-null in here
```

`identify()` is the only method a provider must implement. Everything else — mounting routes,
signing out, refreshing — is a **declared capability** checked at boot, because Clerk cannot sign
a user in from a server and better-auth cannot not-mount routes.

Password hashing, JWT signing, single-use reset tokens and refresh rotation live here, once, and
are shared by every storage brick.

## Documentation

**[https://theoven.app/docs/bricks/auth/](https://theoven.app/docs/bricks/auth/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
