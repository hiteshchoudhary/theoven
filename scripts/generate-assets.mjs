/**
 * Note: the hero glow and the arch render are no longer generated. The landing page dropped
 * both — a radial glow behind the headline and a rendered oven arch read as decoration, and a
 * page selling a backend framework cannot afford decoration. What replaced them is a ruled grid
 * and a pull-quote, neither of which needs an image.
 *
 * Generates landing-page imagery with Gemini.
 *
 * The API key is read from GEMINI_API_KEY and never written to disk or committed — pass it on
 * the command line:
 *
 *   GEMINI_API_KEY=... bun scripts/generate-assets.mjs
 *
 * Output lands in apps/landing/assets/. Regenerating is cheap, so these are committed as build
 * artefacts rather than generated during deploys — a landing page should not depend on a
 * third-party API being up.
 */
import { mkdir, writeFile } from 'node:fs/promises'

const KEY = process.env.GEMINI_API_KEY
if (!KEY) {
  console.error('Set GEMINI_API_KEY.')
  process.exit(1)
}

const MODEL = 'gemini-3-pro-image'
const OUT = new URL('../apps/landing/assets/', import.meta.url)

// A shared style brief keeps the set coherent — without it each image drifts into its own
// aesthetic and the page looks assembled from stock art.
const STYLE = `
Style: premium developer-tool brand art, in the visual language of Vercel, Linear and Stripe.
Deep near-black background (#0a0a0c). Warm ember palette: molten orange (#e8590c), amber
(#ff9d4d), a deep red-brown glow. Cool slate greys for contrast. Volumetric light, soft bloom,
subtle film grain. Geometric and precise, never whimsical or cartoonish. No text, no letters,
no words, no logos, no UI chrome, no people. Cinematic, high detail, 8k.
`.trim()

const ASSETS = [
  {
    name: 'hero-glow',
    aspect: '16:9',
    prompt: `An abstract field of molten heat radiating from the lower centre of the frame, as if
      seen through the door of a forge. Layered ember gradients dissolving into darkness at the
      edges. A faint hexagonal grid structure is barely visible inside the glow, suggesting
      engineering rather than fire. Extremely dark overall so that white text placed on top
      stays readable — the glow occupies only the lower third. ${STYLE}`,
  },
  {
    name: 'og-card',
    aspect: '16:9',
    prompt: `A minimal abstract brand card. A single geometric arch — the silhouette of an oven
      mouth — rendered as a thin luminous orange outline, centred, glowing softly against a
      near-black field. Inside the arch, a soft molten gradient. Generous empty space around the
      arch so text can be composited on later. Restrained, iconic, symmetrical. ${STYLE}`,
  },
  {
    name: 'texture-grain',
    aspect: '1:1',
    prompt: `A seamless dark noise texture: very fine film grain over a near-black field, with
      an almost imperceptible warm tint. Flat, even, no focal point, no gradient, no pattern
      that would tile visibly. Subtle enough to overlay a webpage at low opacity. ${STYLE}`,
  },
]

async function generate({ name, prompt, aspect }) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: aspect },
        },
      }),
    },
  )

  if (!response.ok) {
    console.error(`${name}: HTTP ${response.status}`)
    console.error((await response.text()).slice(0, 400))
    return false
  }

  const payload = await response.json()
  const parts = payload.candidates?.[0]?.content?.parts ?? []
  const image = parts.find((part) => part.inlineData)?.inlineData

  if (!image) {
    console.error(`${name}: no image in response`, JSON.stringify(payload).slice(0, 300))
    return false
  }

  const bytes = Buffer.from(image.data, 'base64')
  await writeFile(new URL(`${name}.png`, OUT), bytes)
  console.log(`${name}.png  ${(bytes.length / 1024).toFixed(0)} KB`)
  return true
}

await mkdir(OUT, { recursive: true })
const results = await Promise.all(ASSETS.map(generate))
console.log(`\n${results.filter(Boolean).length}/${ASSETS.length} generated`)
