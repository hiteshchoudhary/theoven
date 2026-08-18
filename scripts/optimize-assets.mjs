/**
 * Turns the raw generated PNGs into web-ready assets.
 *
 * The generator writes 500–700 KB PNGs. Shipping those on a landing page would undercut the
 * whole pitch — a framework that talks about performance cannot open with a 1.5 MB hero.
 * This converts them to WebP at sensible dimensions and composites the OG card's text as
 * vector, so the type stays crisp instead of being generated as pixels.
 *
 *   bun scripts/optimize-assets.mjs
 */
import { readdir, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const DIR = fileURLToPath(new URL('../apps/landing/assets/', import.meta.url))

// --- Hero background --------------------------------------------------------------------
// 1920 wide is plenty: it sits behind content at low opacity and is never the focal point.
await sharp(`${DIR}hero-glow.png`)
  .resize(1920, 1080, { fit: 'cover' })
  .webp({ quality: 72 })
  .toFile(`${DIR}hero-glow.webp`)

// --- Open Graph card --------------------------------------------------------------------
// Text is composited as SVG rather than asked of the image model: generated lettering is
// unreliable and always slightly wrong, and this way it stays sharp at any scale.
const OG_WIDTH = 1200
const OG_HEIGHT = 630

const overlay = Buffer.from(`
<svg width="${OG_WIDTH}" height="${OG_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#0a0a0c" stop-opacity="0.96"/>
      <stop offset="55%" stop-color="#0a0a0c" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#0a0a0c" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#fade)"/>
  <text x="72" y="286" font-family="Helvetica, Arial, sans-serif" font-size="96"
        font-weight="700" fill="#ffffff" letter-spacing="-3">Oven</text>
  <text x="74" y="344" font-family="Helvetica, Arial, sans-serif" font-size="30"
        font-weight="500" fill="#ff9d4d">The batteries-included Bun framework</text>
  <text x="74" y="396" font-family="Helvetica, Arial, sans-serif" font-size="24"
        fill="#9ca3af">Express-simple. FastAPI-smart. Everything configurable.</text>
  <rect x="72" y="452" width="132" height="4" rx="2" fill="#e8590c"/>
  <text x="74" y="516" font-family="Helvetica, Arial, sans-serif" font-size="22"
        fill="#6b7280">theoven.app</text>
</svg>
`)

await sharp(`${DIR}og-card.png`)
  .resize(OG_WIDTH, OG_HEIGHT, { fit: 'cover' })
  .composite([{ input: overlay, top: 0, left: 0 }])
  .png({ quality: 90, compressionLevel: 9 })
  .toFile(`${DIR}og.png`)

// Keep the clean arch too — it is the strongest piece of brand art we have, and the landing
// page uses it as a standalone visual.
await sharp(`${DIR}og-card.png`)
  .resize(1000, 1000, { fit: 'cover', position: 'centre' })
  .webp({ quality: 78 })
  .toFile(`${DIR}arch.webp`)

// --- Drop the sources -------------------------------------------------------------------
// The generated noise texture is replaced by an inline SVG turbulence filter in CSS: it costs
// zero bytes, tiles perfectly, and cannot band on wide gradients the way a JPEG-ish grain does.
for (const file of ['hero-glow.png', 'og-card.png', 'texture-grain.png']) {
  await unlink(`${DIR}${file}`).catch(() => {})
}

const files = await readdir(DIR)
for (const file of files.sort()) {
  const { size } = await sharp(`${DIR}${file}`).metadata().then(
    async (meta) => ({ size: (await Bun.file(`${DIR}${file}`).arrayBuffer()).byteLength, meta }),
  )
  console.log(`${file.padEnd(18)} ${(size / 1024).toFixed(0).padStart(5)} KB`)
}
