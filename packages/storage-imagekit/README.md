# @theoven/storage-imagekit

[![npm](https://img.shields.io/npm/v/@theoven/storage-imagekit)](https://www.npmjs.com/package/@theoven/storage-imagekit)

> ImageKit for Oven — uploads through the storage contract, plus transformation URLs.

A driver for [`@theoven/storage`](https://www.npmjs.com/package/@theoven/storage), so everything
on `ctx.storage` works unchanged: upload, download, list, delete.

```bash
bun add @theoven/storage @theoven/storage-imagekit
```

## Usage

```ts
import { storage } from '@theoven/storage'
import { imagekitStorage } from '@theoven/storage-imagekit'

const media = imagekitStorage({
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY!,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT!,
})

const app = createApp().use(storage(media))
```

Upload once through `ctx.storage`, then serve any size from the URL — the reason to use ImageKit
rather than plain object storage:

```ts
await ctx.storage.upload('avatars/1.png', file)

media.url('avatars/1.png', { transform: { width: 200, height: 200, format: 'auto' } })
// https://ik.imagekit.io/demo/avatars/1.png?tr=w-200,h-200,f-auto
```

Signed URLs cover the transformation as well as the path, so a client cannot edit `tr=` to
request a 10,000px render off a signed URL.

## Limitations

- **No presigned uploads.** ImageKit's browser upload is a token/signature triple, not a
  `PUT`-able URL.
- **`remove`, `exists` and `stat` cost an extra lookup** — the contract is path-keyed and
  ImageKit works by `fileId`.
- **Uploads are buffered**, and paging is offset-based.

## Documentation

**[https://theoven.app/docs/bricks/storage-imagekit/](https://theoven.app/docs/bricks/storage-imagekit/)**

## License

MIT
