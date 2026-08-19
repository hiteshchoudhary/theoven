/**
 * Fingerprints the landing page's CSS and JS, and rewrites the references to them.
 *
 * `styles.css` was served under a fixed name with a one-hour cache while the HTML was not cached
 * at all. So for an hour after every deploy a returning visitor got **new markup with the old
 * stylesheet** — which does not degrade gracefully, it renders as a broken page: unstyled
 * elements at their natural size, and old rules applied to classes that have since changed
 * meaning. Telling people to hard-refresh is not a fix; it is asking every visitor to debug the
 * deploy.
 *
 * Hashing the contents into the filename makes the problem structurally impossible: changed
 * content is a new URL, so the pair can never be mismatched, and unchanged content keeps its URL
 * and stays cached forever.
 *
 *   bun scripts/fingerprint.mjs <dist-dir>
 */
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DIST = resolve(process.argv[2] ?? 'dist')
const ASSETS = ['styles.css', 'main.js']

/** Short content hash. Eight hex characters is ample for cache busting. */
function hash(contents) {
  return new Bun.CryptoHasher('sha256').update(contents).digest('hex').slice(0, 8)
}

const renames = new Map()

for (const name of ASSETS) {
  const path = join(DIST, name)
  let contents
  try {
    contents = readFileSync(path)
  } catch {
    console.error(`${name} is not in ${DIST} — nothing to fingerprint.`)
    process.exit(1)
  }

  const dot = name.lastIndexOf('.')
  const fingerprinted = `${name.slice(0, dot)}.${hash(contents)}${name.slice(dot)}`

  renameSync(path, join(DIST, fingerprinted))
  renames.set(name, fingerprinted)
}

/**
 * Rewrite every HTML file, not just the landing page.
 *
 * The docs are built by Astro and fingerprint their own assets, but a hand-written page added
 * later could reference these — and a reference the build silently failed to rewrite is a 404
 * that only shows up in production.
 */
let rewritten = 0
let references = 0

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return htmlFiles(path)
    return entry.name.endsWith('.html') ? [path] : []
  })
}

for (const file of htmlFiles(DIST)) {
  const original = readFileSync(file, 'utf8')
  let updated = original

  for (const [from, to] of renames) {
    updated = updated.replaceAll(`/${from}`, `/${to}`)
  }

  if (updated !== original) {
    writeFileSync(file, updated)
    rewritten++
    for (const to of renames.values()) {
      references += updated.split(to).length - 1
    }
  }
}

// A rename with nothing pointing at it means the page would load unstyled — louder to fail here.
if (references === 0) {
  console.error('Fingerprinted the assets, but no HTML references them. Refusing a broken build.')
  process.exit(1)
}

console.log(
  `Fingerprinted ${renames.size} assets (${[...renames.values()].join(', ')}), ` +
    `rewrote ${references} reference(s) across ${rewritten} page(s).`,
)
