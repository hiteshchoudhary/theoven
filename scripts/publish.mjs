/**
 * Publishes every package whose version is not on the registry yet.
 *
 * Uses **`bun publish`**, not `npm publish`, and that is the entire reason this script exists
 * rather than `changeset publish`: changesets shells out to npm, and npm does not understand the
 * `workspace:` protocol. A single `workspace:^` reaching a published `peerDependencies` makes
 * every install fail with EUNSUPPORTEDPROTOCOL. `bun pm pack` rewrites it to a real range.
 *
 * Idempotent: a version already on the registry is skipped rather than retried, so re-running
 * after a partial failure finishes the job instead of erroring on what already worked.
 *
 *   bun scripts/publish.mjs [--dry-run]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DRY = process.argv.includes('--dry-run')

/** Publish order: a package is published after everything it peers on. */
function order(manifests) {
  const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]))
  const done = new Set()
  const sorted = []

  function visit(entry, trail) {
    if (done.has(entry.manifest.name)) return
    if (trail.includes(entry.manifest.name)) {
      throw new Error(`Dependency cycle: ${[...trail, entry.manifest.name].join(' → ')}`)
    }

    const deps = {
      ...(entry.manifest.dependencies ?? {}),
      ...(entry.manifest.peerDependencies ?? {}),
    }
    for (const name of Object.keys(deps)) {
      const target = byName.get(name)
      if (target) visit(target, [...trail, entry.manifest.name])
    }

    done.add(entry.manifest.name)
    sorted.push(entry)
  }

  for (const entry of manifests) visit(entry, [])
  return sorted
}

const packages = readdirSync(join(ROOT, 'packages'))
  .map((name) => join(ROOT, 'packages', name))
  .filter((directory) => existsSync(join(directory, 'package.json')))
  .map((directory) => ({
    directory,
    manifest: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')),
  }))
  .filter((entry) => !entry.manifest.private)

let published = 0
let skipped = 0
const failed = []

for (const { directory, manifest } of order(packages)) {
  const { name, version } = manifest

  // The registry is the source of truth for what exists, not a changelog or a git tag.
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (response.ok) {
    const known = await response.json()
    if (known.versions?.[version]) {
      console.log(`  = ${name}@${version} already published`)
      skipped++
      continue
    }
  }

  console.log(`  → ${name}@${version}`)
  if (DRY) {
    published++
    continue
  }

  const result = Bun.spawnSync(['bun', 'publish'], { cwd: directory, stdio: ['inherit', 'inherit', 'inherit'] })
  if (result.exitCode !== 0) {
    /**
     * Carry on rather than stopping.
     *
     * One package failing for its own reason — a credential that cannot create a new unscoped
     * name, say — should not leave the packages after it in the order unpublished. Finding out
     * about every failure in one run beats discovering them one re-run at a time, and the
     * script is idempotent, so a fix is followed by a plain re-run.
     */
    failed.push(`${name}@${version}`)
    continue
  }
  published++
}

console.log(`\n${published} published, ${skipped} already up to date.`)

if (failed.length > 0) {
  console.error(`\n${failed.length} failed: ${failed.join(', ')}`)
  console.error('Fix the cause and re-run — anything already published is skipped.')
  process.exit(1)
}
