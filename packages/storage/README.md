# @theoven/storage

[![npm](https://img.shields.io/npm/v/@theoven/storage)](https://www.npmjs.com/package/@theoven/storage)

> Object storage for Oven — S3, R2, MinIO and Spaces, with a local-disk driver so uploads work before you have a bucket.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/storage
```

## Usage

```ts
import { storage, s3Storage, diskStorage } from '@theoven/storage'

const app = createApp().use(storage(
  env.has('S3_BUCKET') ? s3Storage({ bucket: env.string('S3_BUCKET') }) : diskStorage({ dir: './storage' }),
))

await ctx.storage.upload(`avatars/${ctx.user.id}`, ctx.body.file)
```

A multipart upload streams from Bun's temporary spill file straight to the bucket — nothing calls
`arrayBuffer()`, so a 5GB upload never passes through your heap. Multipart is automatic.

`ctx.storage.directUpload(key)` returns a ticket a browser uses to `PUT` straight to the bucket,
so a large file never touches your server. The disk driver is refused in production, because
uploads on a container filesystem vanish on the next deploy while the service looks healthy.

## Documentation

**[https://theoven.app/docs/bricks/storage/](https://theoven.app/docs/bricks/storage/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
