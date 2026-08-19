# @theoven/auth-clerk

[![npm](https://img.shields.io/npm/v/@theoven/auth-clerk)](https://www.npmjs.com/package/@theoven/auth-clerk)

> Clerk-hosted sign-in for Oven, verified on every request. No routes, no sessions to manage.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/auth @theoven/auth-clerk
```

## Usage

```ts
import { clerkAuth } from '@theoven/auth-clerk'

const app = createApp().use(auth(clerkAuth({ issuer: env.url('CLERK_ISSUER') })))
```

No Clerk SDK — JWKS fetch, RS256 verification and the issuer/expiry/authorized-party checks, on
WebCrypto. The token's `alg` is checked rather than trusted, because trusting it is the classic
JWT break.

Mounts nothing and declares `signOut: false`: Clerk owns the session, and a `signOut()` that
quietly did nothing would be found by a user who clicked it and stayed signed in.

## Documentation

**[https://theoven.app/docs/bricks/auth-clerk/](https://theoven.app/docs/bricks/auth-clerk/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
