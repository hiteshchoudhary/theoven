# @theoven/image

Resize, convert and guard images on `Bun.Image`. No native module, nothing to install.

```bash
bun add @theoven/image
```

```ts
import { image } from '@theoven/image'

const app = createApp().use(image({ format: 'webp' }))
```

```ts
// src/routes/avatar.post.ts
export default async (ctx) => {
  const [file] = (await ctx.files()).avatar
  if (!file) throw new BadRequest('Expected an "avatar" file.')

  const avatar = await ctx.image.transform(file, { width: 256, height: 256 })
  await ctx.storage.upload(`avatars/${ctx.user.id}.webp`, avatar.bytes)
  return { ok: true }
}
```

## Why a brick rather than calling `Bun.Image` directly

Because of the part that is easy to leave out: **refusing an image before decoding it.**

A 70 KB PNG can carry 4000×4000 pixels. Nothing about the request looks unusual — 70 KB is
nothing — but decoding it costs 16 megapixels of memory, and a handful arriving together will
end a small server. A byte limit cannot see it coming.

Reading the header first costs **0.6 µs** against **44 ms** for the decode, so the guard is
effectively free:

| source | on the wire | header read | resize + encode |
| --- | ---: | ---: | ---: |
| 800×600 | 3 KB | 0.8 µs | 3.8 ms |
| 2000×1500 | 15 KB | 0.4 µs | 7.7 ms |
| 4000×4000 | 70 KB | 0.6 µs | 44.4 ms |

Header reads are constant time; decoding is linear in pixels. The bigger the attack, the wider
the margin.

The brick also refuses to upscale by default — `Bun.Image` will happily render a 200px upload at
8000px if asked — and applies your format and quality defaults so they are not restated at every
call site.

## Portability, which will bite you otherwise

`Bun.Image` runs on two backends. `system` is the default on macOS and Windows; `bun` is what
every Linux server uses.

| format | `system` | `bun` (Linux) |
| --- | --- | --- |
| JPEG, PNG, WebP | yes | yes — **byte-identical** |
| AVIF, HEIC | yes | **no** |

So AVIF works on a Mac and fails on the server. This brick checks the configured format at
**boot** and refuses to start with a message naming the problem, rather than letting you find out
when a user uploads something.

Set `backend: 'bun'` in development to get exactly what production will produce.

## Honest limits

- **AVIF and HEIC cannot be produced on Linux.** Not a limitation we can fix.
- **`variants()` decodes once per width** — a 320/640/1280 ladder is ~83 ms. That is a queue job,
  not a request.
- **No cropping, compositing, text, or colour management.** `Bun.Image` does resize, rotate,
  flip and brightness/saturation. Anything more is a different tool.
- **No SVG.** It is not a raster format and is a script-execution surface besides.

Image work does not block the event loop — a 110 ms resize still served 87 timer ticks — so a
resize in a handler costs that request its latency, not the process's.

Full documentation: <https://theoven.app/docs/bricks/image/>

MIT
