# @theoven/auth-mongo

[![npm](https://img.shields.io/npm/v/@theoven/auth-mongo)](https://www.npmjs.com/package/@theoven/auth-mongo)

> The auth-basic flows, stored in MongoDB with Mongoose.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/auth @theoven/auth-mongo mongoose
```

## Usage

```ts
import { mongoAuth } from '@theoven/auth-mongo'

const app = createApp().use(auth(mongoAuth({ connection, secret: env.string('AUTH_SECRET') })))
```

Identical to `@theoven/auth-basic` in every observable way — the same eight endpoints, the same
tokens, the same rate limits. Only the storage differs, and a test asserts the endpoint lists
match exactly.

Both bricks run the same `AuthStore` conformance suite from `@theoven/auth/testing`.

## Documentation

**[https://theoven.app/docs/bricks/auth-mongo/](https://theoven.app/docs/bricks/auth-mongo/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
