# @theoven/auth-basic

[![npm](https://img.shields.io/npm/v/@theoven/auth-basic)](https://www.npmjs.com/package/@theoven/auth-basic)

> Email and password auth that works out of the box — signup, login, refresh, logout, password change and reset.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/auth @theoven/auth-basic
```

## Usage

```ts
import { basicAuth } from '@theoven/auth-basic'

const app = createApp().use(auth(basicAuth({ db: client, secret: env.string('AUTH_SECRET') })))
// eight endpoints at /auth/*, rate limited by default
```

argon2id hashing, a 15-minute access JWT plus a revocable refresh token, single-use hashed reset
tokens, and login that does not reveal which emails exist — an unknown address still pays a full
argon2 verification against a decoy.

Login, signup and reset are rate limited on **both** IP and email: either key alone leaves a hole.

## Documentation

**[https://theoven.app/docs/bricks/auth-basic/](https://theoven.app/docs/bricks/auth-basic/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
