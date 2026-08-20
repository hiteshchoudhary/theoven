/**
 * Fails the build on a broken internal link.
 *
 * This exists because mounting the docs under `/docs` created three separate classes of broken
 * link, each of which looked fine in review:
 *
 *   1. Starlight prefixes `base` onto links it generates, so a sidebar entry written as `/`
 *      silently became `/docs/` — a link back to the docs root instead of the site root.
 *   2. Markdown link targets are emitted verbatim and are *not* prefixed, so `/tutorial/errors/`
 *      written in MDX pointed at a path that does not exist.
 *   3. Deleting the docs splash page left `/docs/` with no index at all, which is the single
 *      most-linked path on the landing page.
 *
 * All three were invisible until someone clicked. A crawl over the built output is cheap and
 * catches every one of them, so it runs as the last step of the build rather than being left
 * to a human noticing a 404 in production.
 *
 *   bun scripts/check-links.mjs [dist-dir]
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DIST = resolve(process.argv[2] ?? 'dist')

if (!existsSync(DIST)) {
  console.error(`No such directory: ${DIST}. Run the build first.`)
  process.exit(1)
}

/** Every .html file under dist, recursively. */
async function htmlFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await htmlFiles(path)))
    else if (entry.name.endsWith('.html')) found.push(path)
  }
  return found
}

/**
 * A link resolves if it names a file, or a directory containing index.html.
 * Both forms are legitimate: `/styles.css` is a file, `/docs/` is a directory.
 */
function resolves(href) {
  const target = join(DIST, decodeURIComponent(href))
  if (existsSync(target)) {
    return statSync(target).isDirectory() ? existsSync(join(target, 'index.html')) : true
  }
  // Extensionless routes may have been emitted as a sibling .html file.
  return existsSync(`${target}.html`)
}

/** The HTML file a resolvable href actually reads from, so its anchors can be collected. */
function pageFile(href) {
  const target = join(DIST, decodeURIComponent(href))
  if (existsSync(target) && statSync(target).isDirectory()) {
    const index = join(target, 'index.html')
    return existsSync(index) ? index : undefined
  }
  if (existsSync(target) && target.endsWith('.html')) return target
  return existsSync(`${target}.html`) ? `${target}.html` : undefined
}

/**
 * Refuses to check output older than the sources it was built from.
 *
 * Learned the boring way: running this against a `dist/` from an earlier build reported every
 * link resolving while a page added since then was not in it at all. A link checker that can
 * pass on stale output is worse than none, because it is trusted.
 */
async function newestSource(dir) {
  let newest = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue
    }
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? await newestSource(path) : statSync(path).mtimeMs)
  }
  return newest
}

const SOURCES = ['apps/web/src', 'apps/landing'].filter((dir) => existsSync(dir))
if (SOURCES.length > 0) {
  const built = statSync(DIST).mtimeMs
  const sources = Math.max(...(await Promise.all(SOURCES.map(newestSource))))

  if (sources > built) {
    console.error(
      `${DIST} is older than the site sources, so this check would pass on output that no ` +
        'longer matches the pages. Run the build first: bash scripts/build-site.sh',
    )
    process.exit(1)
  }
}

const pages = await htmlFiles(DIST)
const broken = new Map()
let checked = 0
let anchors = 0

/**
 * Every `id` a page defines, so a link to `#some-heading` can be checked.
 *
 * Anchors were out of scope until the docs started linking to specific sections rather than whole
 * pages. A heading that gets reworded silently breaks every deep link to it and the page still
 * returns 200 — which is exactly the kind of rot nothing else here would catch.
 */
const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]))

/** Cached, because many pages link into the same few. */
const idCache = new Map()
function idsForPage(href) {
  if (idCache.has(href)) return idCache.get(href)
  const file = pageFile(href)
  const ids = file ? idsOf(readFileSync(file, 'utf8')) : undefined
  idCache.set(href, ids)
  return ids
}

for (const page of pages) {
  const html = readFileSync(page, 'utf8')
  const label = page.replace(`${DIST}/`, '')

  // Only site-absolute links. External URLs and mailto: are out of scope — a link checker that
  // hits the network is a link checker that fails when someone else's site is down.
  const found = new Set(
    [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)]
      .map((match) => match[1].split('?')[0])
      .filter(Boolean),
  )

  for (const raw of found) {
    const [href, fragment] = raw.split('#')
    if (!href) continue

    checked++
    if (!resolves(href)) {
      if (!broken.has(raw)) broken.set(raw, new Set())
      broken.get(raw).add(label)
      continue
    }

    if (!fragment) continue

    anchors++
    const ids = idsForPage(href)
    // A page we cannot read is not an anchor failure — `resolves` already vouched for it.
    if (ids && !ids.has(fragment)) {
      const key = `${href}#${fragment}`
      if (!broken.has(key)) broken.set(key, new Set())
      broken.get(key).add(`${label} (no such anchor)`)
    }
  }
}

console.log(`Checked ${checked} internal links (${anchors} with anchors) across ${pages.length} pages.`)

if (broken.size === 0) {
  console.log('All internal links resolve.')
  process.exit(0)
}

console.error(`\n${broken.size} broken link${broken.size === 1 ? '' : 's'}:\n`)
for (const [href, sources] of [...broken].sort()) {
  console.error(`  ${href}`)
  for (const source of [...sources].sort().slice(0, 4)) console.error(`      on ${source}`)
  if (sources.size > 4) console.error(`      ...and ${sources.size - 4} more`)
}
process.exit(1)
