# @theoven/image

## 0.6.0

### Minor Changes

- dee857d: The image brick: resize, convert and guard uploads on `Bun.Image`.
  
  ```ts
  app.use(image({ format: 'webp' }))
  
  const avatar = await ctx.image.transform(file, { width: 256, height: 256 })
  ```
  
  No native module and nothing to install. The reason it is a brick rather than a note telling you
  to call `Bun.Image` yourself is the part that is easy to leave out: a 4000x4000 PNG of flat
  colour compresses to 70 KB, and decoding it costs 16 megapixels. Reading the header first costs
  0.6us against 44ms for the decode, so every method checks dimensions against your limits before
  anything is decoded, and an oversized upload comes back as a 413.
  
  It also refuses to upscale unless asked, and checks the configured format at boot — AVIF and
  HEIC encode on macOS and Windows but not on Linux, so a Mac developer would otherwise ship a
  server that rejects every image.

### Patch Changes

- Updated dependencies [dee857d]
- Updated dependencies [50ce9ed]
- Updated dependencies [c69c632]
- Updated dependencies [313025d]
- Updated dependencies [313025d]
- Updated dependencies [ef8bb69]
- Updated dependencies [8589b1e]
- Updated dependencies [e59fb64]
- Updated dependencies [1ae044a]
  - @theoven/core@0.6.0
