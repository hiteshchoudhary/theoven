/**
 * Image processing on `Bun.Image`.
 *
 * The number that matters is not "how fast is a resize" — it is the ratio between reading a
 * header and decoding the pixels, because that ratio is what makes it affordable to refuse a
 * hostile upload. If reading the header cost anything close to a decode, the guard in
 * `@theoven/image` would be theatre.
 */

/** A minimal uncompressed 24-bit BMP, so this file needs no fixtures. */
function bmp(width: number, height: number): Uint8Array {
  const rowRaw = width * 3
  const rowSize = rowRaw + ((4 - (rowRaw % 4)) % 4)
  const out = new Uint8Array(54 + rowSize * height)
  const view = new DataView(out.buffer)
  out[0] = 0x42
  out[1] = 0x4d
  view.setUint32(2, out.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, -height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, rowSize * height, true)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3
      out[offset] = ((x * 255) / width) | 0
      out[offset + 1] = ((y * 255) / height) | 0
      out[offset + 2] = 200
    }
  }
  return out
}

async function time(label: string, runs: number, work: () => Promise<unknown>): Promise<number> {
  await work() // warm up
  const started = performance.now()
  for (let index = 0; index < runs; index += 1) await work()
  const perRun = (performance.now() - started) / runs
  // Sub-millisecond work printed as `0.00 ms` is what makes a ratio look made up.
  const shown = perRun < 1 ? `${(perRun * 1000).toFixed(1)} us` : `${perRun.toFixed(2)} ms`
  console.log(`${label.padEnd(42)} ${shown.padStart(10)}`)
  return perRun
}

console.log(`\nBun.Image — backend "${Bun.Image.backend}", Bun ${Bun.version}\n`)

const sizes: Array<[number, number]> = [
  [800, 600],
  [2000, 1500],
  [4000, 4000],
]

console.log('Header read vs full decode\n')
for (const [width, height] of sizes) {
  const source = await new Bun.Image(bmp(width, height)).png().bytes()
  const megapixels = ((width * height) / 1_000_000).toFixed(1)
  const kb = (source.length / 1024).toFixed(0)

  const meta = await time(`  ${width}x${height} (${megapixels} MP, ${kb} KB)  metadata`, 50, () =>
    new Bun.Image(source).metadata(),
  )
  const decode = await time(
    `  ${width}x${height} (${megapixels} MP, ${kb} KB)  resize+encode`,
    10,
    () => new Bun.Image(source).resize(256).webp().bytes(),
  )
  console.log(`  ${' '.repeat(40)} guard is ${(decode / meta).toFixed(0)}x cheaper than decoding\n`)
}

console.log('Encoders, 2000x1500 source, resized to 512 wide\n')
const source = await new Bun.Image(bmp(2000, 1500)).png().bytes()
for (const format of ['jpeg', 'png', 'webp'] as const) {
  const bytes = await new Bun.Image(source).resize(512)[format]().bytes()
  await time(`  ${format} (${(bytes.length / 1024).toFixed(0)} KB out)`, 10, () =>
    new Bun.Image(source).resize(512)[format]().bytes(),
  )
}

console.log('\nsrcset ladder and placeholder\n')
await time('  variants 320/640/1280 (three decodes)', 10, async () => {
  for (const width of [320, 640, 1280]) {
    await new Bun.Image(source).resize(width).webp().bytes()
  }
})
await time('  placeholder (ThumbHash data URL)', 20, () => new Bun.Image(source).placeholder())

console.log('\nDoes it block the event loop?\n')
let ticks = 0
const timer = setInterval(() => {
  ticks += 1
}, 1)
const started = performance.now()
await new Bun.Image(source).resize(1500).png().bytes()
const elapsed = performance.now() - started
clearInterval(timer)
console.log(
  `  ${elapsed.toFixed(0)} ms resize saw ${ticks} timer ticks — ${ticks > 0 ? 'off-thread, the server keeps serving' : 'BLOCKING'}\n`,
)
