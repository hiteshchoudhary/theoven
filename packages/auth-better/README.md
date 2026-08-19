# @theoven/auth-better

[![npm](https://img.shields.io/npm/v/@theoven/auth-better)](https://www.npmjs.com/package/@theoven/auth-better)

> better-auth mounted in Oven — it brings its own routes, sessions and plugins.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/auth @theoven/auth-better better-auth
```

## Usage

```ts
import { betterAuthProvider } from '@theoven/auth-better'

const instance = betterAuth({ database, basePath: '/auth', emailAndPassword: { enabled: true } })
const app = createApp().use(auth(betterAuthProvider({ instance })))
```

You build the instance; this brick mounts it. better-auth's configuration is large and moving,
and a wrapper around it would be permanently a release behind.

A `basePath` that does not match the mount prefix fails at boot — otherwise it is a 404 from
*inside* better-auth that looks exactly like a routing bug in Oven.

## Documentation

**[https://theoven.app/docs/bricks/auth-better/](https://theoven.app/docs/bricks/auth-better/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
