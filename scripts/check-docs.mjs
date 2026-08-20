/**
 * Checks the code samples in the documentation.
 *
 * Two things, both chosen because they catch real rot without demanding that every snippet be a
 * complete compilable module — most are fragments, and rewriting 135 of them into standalone
 * programs would make the docs worse to read in order to make them checkable.
 *
 *   1. **Every block parses.** A truncated snippet, a stray brace, an arrow function left with
 *      the old signature — all of it fails here.
 *   2. **Every name imported from `@theoven/*` actually exists.** This is the rot that matters:
 *      renaming an export and leaving the docs describing the old one is how a page becomes a
 *      trap. Type-only imports are checked against the source text, since types are erased at
 *      runtime and cannot be read off the module.
 *
 *   bun scripts/check-docs.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DOCS = join(ROOT, 'apps/web/src/content/docs')

function mdxFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return mdxFiles(path)
    return /\.mdx?$/.test(entry) ? [path] : []
  })
}

/** Fenced blocks, with the line the fence opened on so a failure points somewhere useful. */
function blocks(source) {
  const found = []
  const lines = source.split('\n')
  let open = null

  for (const [index, line] of lines.entries()) {
    const fence = /^```(\w+)?/.exec(line)
    if (!fence) continue

    if (open) {
      found.push({ language: open.language, code: lines.slice(open.line, index).join('\n'), line: open.line + 1 })
      open = null
    } else if (fence[1]) {
      open = { language: fence[1], line: index + 1 }
    } else {
      // A bare ``` closes a block; one that opens with no language is not code we can check.
      open = { language: '', line: index + 1 }
    }
  }

  return found.filter((block) => /^(ts|tsx|typescript|js|javascript)$/.test(block.language))
}

/** What a package really exports, plus the type names its source declares. */
async function exportsOf(specifier) {
  const runtime = new Set(Object.keys(await import(specifier)))

  // `export type { X }` and `export interface X` vanish at runtime, so they are read from the
  // source. Cheaper and more honest than compiling the package to find out.
  const directory = join(ROOT, 'packages', specifier.replace('@theoven/', ''))
  const types = new Set()
  try {
    for (const file of readdirSync(join(directory, 'src'))) {
      if (!file.endsWith('.ts')) continue
      const source = readFileSync(join(directory, 'src', file), 'utf8')
      for (const [, name] of source.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)) types.add(name)
      for (const [, names] of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
        for (const part of names.split(',')) {
          const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
          if (name) types.add(name)
        }
      }
    }
  } catch {
    // A package without a src directory contributes no type names, which is not an error.
  }

  return new Set([...runtime, ...types])
}

const transpiler = new Bun.Transpiler({ loader: 'tsx' })

/**
 * Does this block parse, as a program *or* as the fragment it plainly is?
 *
 * Most samples in the docs are fragments on purpose — a bare object showing the shape of a
 * schema, a property showing what a brick declares. Rewriting 135 of them into standalone
 * programs would make the pages worse to read in order to make them checkable, which is the
 * wrong trade. So a block that fails as a program is retried as an object literal and as a
 * function body, and `...` — which everyone reads as "your code here" — is substituted first.
 *
 * A genuine syntax error still fails every attempt.
 */
function parses(code) {
  const placeholderless = code
    .replace(/=>\s*\.\.\.(?=[\s,)\]}]|$)/g, '=> undefined')
    .replace(/\(\s*\.\.\.\s*\)/g, '()')
    .replace(/^\s*\.\.\.\s*$/gm, ';')

  for (const candidate of [
    placeholderless,
    `const __fragment = ${placeholderless}`,
    `async function __fragment() {\n${placeholderless}\n}`,
    // A bare property, e.g. a page showing just what a brick declares.
    `const __fragment = {\n${placeholderless}\n}`,
    // A continued method chain, e.g. showing one line of a query builder in isolation.
    `const __fragment = __x${placeholderless}`,
  ]) {
    try {
      transpiler.transformSync(candidate)
      return true
    } catch {
      // Try the next shape.
    }
  }
  return false
}
const problems = []
const known = new Map()
let checked = 0
let imports = 0

/**
 * Every README as well as the docs site.
 *
 * The root README claimed a `defineConfig({ db: { driver } })` API that never existed, and said
 * "nothing is published to npm yet" long after eighteen packages were. It survived because this
 * check only ever looked at `apps/web`. The front page is the most-read documentation there is.
 */
function readmes() {
  const found = [join(ROOT, 'README.md')]
  const packages = join(ROOT, 'packages')
  for (const entry of readdirSync(packages)) {
    const path = join(packages, entry, 'README.md')
    try {
      if (statSync(path).isFile()) found.push(path)
    } catch {
      // A package without a README is caught by check-publish, not here.
    }
  }
  return found
}

for (const file of [...mdxFiles(DOCS), ...readmes()].sort()) {
  const relative = file.replace(`${ROOT}/`, '')
  const source = readFileSync(file, 'utf8')

  for (const block of blocks(source)) {
    checked++

    if (!parses(block.code)) {
      problems.push(`${relative}:${block.line} — does not parse, as a program or as a fragment`)
      // A block that does not parse cannot have its imports read either.
      continue
    }

    for (const [, typeOnly, names, specifier] of block.code.matchAll(
      /import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"](@theoven\/[\w-]+)['"]/g,
    )) {
      if (!known.has(specifier)) {
        try {
          known.set(specifier, await exportsOf(specifier))
        } catch {
          problems.push(`${relative}:${block.line} — imports from ${specifier}, which does not resolve`)
          known.set(specifier, null)
        }
      }

      const available = known.get(specifier)
      if (!available) continue

      for (const part of names.split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
        if (!name) continue
        imports++

        if (!available.has(name)) {
          problems.push(
            `${relative}:${block.line} — ${specifier} has no export "${name}"` +
              (typeOnly ? ' (type import)' : ''),
          )
        }
      }
    }
  }
}

/**
 * Version numbers written into prose go stale silently.
 *
 * The docs and the landing page both name the current release. Nothing else notices when one of
 * them is left behind, and a page confidently advertising a version that is two releases old is
 * worse than one that names none — so any `0.x.y` in a "shipped at" claim has to match the
 * packages.
 */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8')).version

for (const file of [
  'apps/landing/index.html',
  'apps/web/src/content/docs/index.mdx',
  'apps/web/src/content/docs/start/installation.mdx',
]) {
  const path = join(ROOT, file)
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    continue
  }

  // Only claims *about the release*, not every number that looks like a version — a peer range
  // or a dependency example is nobody's business here.
  for (const [claim, found] of source.matchAll(
    /(?:v|at |version )(\d+\.\d+\.\d+)(?![\w.-])/gi,
  )) {
    if (found !== VERSION) {
      problems.push(`${file} — claims ${claim.trim()}, but the packages are at ${VERSION}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) in the documentation's code samples:\n`)
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}

console.log(`${checked} code samples parse; ${imports} imported names all exist.`)
