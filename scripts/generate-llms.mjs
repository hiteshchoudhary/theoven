/**
 * Writes llms.txt and llms-full.txt from the docs sources.
 *
 * Generated at build time rather than hand-maintained, for the obvious reason: a hand-written
 * index of forty pages is wrong within a month, and wrong in a way nobody notices because
 * nobody reads it — only models do, and they do not complain.
 *
 * Two files, following https://llmstxt.org:
 *
 *   /llms.txt       an index — every page, its one-line description, its URL
 *   /llms-full.txt  the full text of every page, so a model needs no further fetches
 *
 *   bun scripts/generate-llms.mjs [dist-dir]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DOCS = join(ROOT, 'apps/web/src/content/docs')
const OUT = resolve(process.argv[2] ?? join(ROOT, 'dist'))
const SITE = 'https://theoven.app'

if (!existsSync(DOCS)) {
  console.error(`No docs directory at ${DOCS}.`)
  process.exit(1)
}

/**
 * Section order, and what each is for.
 *
 * Explicit rather than alphabetical: a model reading top to bottom should meet the ideas in the
 * order a person would, and "bricks" before "reference" is a different document than the
 * reverse.
 */
const SECTIONS = [
  ['start', 'Start here'],
  ['tutorial', 'Tutorial'],
  ['guides', 'Guides'],
  ['bricks', 'Bricks — add one, get a feature'],
  ['reference', 'Reference'],
  ['', 'Other'],
]

async function mdxFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await mdxFiles(path)))
    else if (/\.mdx?$/.test(entry.name)) found.push(path)
  }
  return found
}

/**
 * Frontmatter, parsed just far enough for the keys these pages use.
 *
 * Including the nested `sidebar.order`, because that is what puts the bricks in the order their
 * author intended rather than alphabetical — and a catalogue that opens with `auth-basic`
 * instead of the overview reads as though nobody arranged it.
 */
function frontmatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  if (!match) return { data: {}, body: source }

  const data = {}
  for (const line of match[1].split('\n')) {
    const top = /^(\w+):\s*(.*)$/.exec(line)
    if (top && top[2] !== '') {
      data[top[1]] = top[2].replace(/^["']|["']$/g, '')
      continue
    }
    const nested = /^\s+order:\s*(\d+)$/.exec(line)
    if (nested) data.order = Number(nested[1])
  }
  return { data, body: source.slice(match[0].length) }
}

/** `bricks/auth-basic.mdx` and `bricks/index.mdx` both become `/docs/bricks/…/`. */
function urlFor(file) {
  const slug = relative(DOCS, file)
    .replace(/\.mdx?$/, '')
    .replace(/\/index$/, '')
    .replace(/^index$/, '')
  return slug ? `${SITE}/docs/${slug}/` : `${SITE}/docs/`
}

/**
 * Turns MDX into plain Markdown.
 *
 * Component imports and JSX wrappers are noise to a reader that cannot render them; the text
 * inside an `<Aside>` is not. So the tags go and their contents stay.
 */
function toMarkdown(body) {
  return body
    .replace(/^import\s.*$/gm, '')
    .replace(/<(Aside|Steps|Card|CardGrid|Tabs|TabItem|LinkCard|Badge)\b[^>]*>/g, '')
    .replace(/<\/(Aside|Steps|Card|CardGrid|Tabs|TabItem|LinkCard|Badge)>/g, '')
    .replace(/<(Aside|Steps|Card|CardGrid|Tabs|TabItem|LinkCard|Badge)\b[^>]*\/>/g, '')
    // Site-absolute doc links become full URLs, so they still resolve out of context.
    .replace(/\]\((\/docs\/[^)]*)\)/g, `](${SITE}$1)`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const files = await mdxFiles(DOCS)
const pages = files
  .map((file) => {
    const { data, body } = frontmatter(readFileSync(file, 'utf8'))
    const section = relative(DOCS, file).split('/')[0]
    return {
      title: data.title ?? 'Untitled',
      description: data.description ?? '',
      url: urlFor(file),
      section: SECTIONS.some(([key]) => key === section) ? section : '',
      order: data.order ?? Number.POSITIVE_INFINITY,
      markdown: toMarkdown(body),
    }
  })
  /**
   * Sidebar order first, then title.
   *
   * Titles are the tiebreak rather than URLs because the tutorial numbers its pages — sorting
   * by URL puts "3. Errors" before "1. Your first route", which is exactly the wrong reading
   * order for the one section that has a reading order.
   */
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))

const HEADER = `# Oven

> A batteries-included backend framework for Bun. Infrastructure — auth, database, mail,
> storage, queues — is configuration rather than wiring: add a brick, get a feature, fully typed.

Oven is TypeScript-native and Bun-only. Routes are files, validation is
[Standard Schema](https://standardschema.dev) so Zod and Valibot both work, errors are RFC 9457
problem+json, and an OpenAPI 3.1 document is generated from the same schemas that validate.

Key things to know before writing code:

- Handlers **return values**. There is no \`res\`, no \`res.json()\`, no \`next()\`.
- Errors are thrown: \`throw new NotFound('...')\`. They become problem+json.
- \`ctx.db\` is the **native** ORM client — a Drizzle instance, a Mongoose connection — not a
  wrapper. There is no Oven query API to learn.
- Bricks contribute to the context. Leaving one out makes using it a compile error.
- Express middleware does not work here. Oven middleware is \`(ctx, next) => Response\`.
`

// ---------------------------------------------------------------------------------------
// llms.txt — the index
// ---------------------------------------------------------------------------------------

const index = [HEADER]

for (const [key, heading] of SECTIONS) {
  const inSection = pages.filter((page) => page.section === key)
  if (inSection.length === 0) continue

  index.push(`\n## ${heading}\n`)
  for (const page of inSection) {
    const summary = page.description ? `: ${page.description}` : ''
    index.push(`- [${page.title}](${page.url})${summary}`)
  }
}

index.push(`\n## Full text\n`)
index.push(`- [Everything above, in full](${SITE}/llms-full.txt)`)

// ---------------------------------------------------------------------------------------
// llms-full.txt — every page
// ---------------------------------------------------------------------------------------

const full = [HEADER]

for (const [key, heading] of SECTIONS) {
  const inSection = pages.filter((page) => page.section === key)
  if (inSection.length === 0) continue

  full.push(`\n\n${'='.repeat(88)}\n# ${heading}\n${'='.repeat(88)}`)
  for (const page of inSection) {
    full.push(`\n\n---\n\n## ${page.title}\n\nSource: ${page.url}\n`)
    if (page.description) full.push(`> ${page.description}\n`)
    full.push(page.markdown)
  }
}

/**
 * A sanity floor.
 *
 * The failure this catches is a path change that makes `mdxFiles` find two pages instead of
 * thirty: both files still get written, the build still passes, and the index quietly becomes
 * useless. Better to stop the build.
 */
if (pages.length < 20) {
  console.error(`Only ${pages.length} docs pages found under ${DOCS}. That is too few to be right.`)
  process.exit(1)
}

writeFileSync(join(OUT, 'llms.txt'), `${index.join('\n')}\n`)
writeFileSync(join(OUT, 'llms-full.txt'), `${full.join('\n')}\n`)

const size = (name) => `${(readFileSync(join(OUT, name), 'utf8').length / 1024).toFixed(1)}KB`
console.log(`Wrote llms.txt (${size('llms.txt')}) and llms-full.txt (${size('llms-full.txt')}) from ${pages.length} pages.`)
