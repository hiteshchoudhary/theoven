# @theoven/core

[![npm](https://img.shields.io/npm/v/@theoven/core)](https://www.npmjs.com/package/@theoven/core)

> The Bun framework itself — router, context, validation, OpenAPI, and the always-on batteries.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/core
```

## Usage

```ts
import { createApp } from '@theoven/core'
import { z } from 'zod'

const app = createApp()

app.get('/users/:id', { params: z.object({ id: z.uuid() }) }, (ctx) => ({
  id: ctx.params.id,          // typed from the schema
}))

await app.listen(3000)
```

Cookies, body parsing, file uploads, token capture, query parsing, request ids, structured
logging, RFC 9457 errors and graceful shutdown are **always on**. There is nothing to install and
nothing to order — if 80% of apps need it, it is not a plugin.

Everything is lazy: a route that returns a string parses no body, no query and no cookies.

## Documentation

**[https://theoven.app/docs](https://theoven.app/docs)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
