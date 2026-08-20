# @theoven/storage-bunny

[![npm](https://img.shields.io/npm/v/@theoven/storage-bunny)](https://www.npmjs.com/package/@theoven/storage-bunny)

> Bunny.net Storage for Oven — object storage plus signed pull-zone URLs.

A driver for [`@theoven/storage`](https://www.npmjs.com/package/@theoven/storage), so everything
on `ctx.storage` works unchanged: upload, download, list, delete.

```bash
bun add @theoven/storage @theoven/storage-bunny
```

## Usage

```ts
import { storage } from '@theoven/storage'
import { bunnyStorage } from '@theoven/storage-bunny'

const app = createApp().use(
  storage(
    bunnyStorage({
      zone: process.env.BUNNY_ZONE!,
      accessKey: process.env.BUNNY_ACCESS_KEY!,   // the zone password, not the account key
      pullZone: 'cdn.example.com',                // reads go through the edge
    }),
  ),
)
```

```ts
await ctx.storage.upload('reports/q3.pdf', file)
const blob = ctx.storage.download('reports/q3.pdf')   // lazy — no request until read
await ctx.storage.list({ prefix: 'reports/', limit: 50 })
await ctx.storage.delete('reports/q3.pdf')
```

With `pullZone` and `tokenKey` set, `presignDownload()` issues signed delivery URLs. The zone
password is never sent to the pull-zone host.

## Limitations

- **No presigned uploads.** Bunny's token authentication protects delivery only, so upload
  through your server rather than browser-direct.
- **Uploads are buffered** — Bunny's `PUT` needs a known length.
- **`list` is directory-based**, and paged client-side.

## Documentation

**[https://theoven.app/docs/bricks/storage-bunny/](https://theoven.app/docs/bricks/storage-bunny/)**

## License

MIT
