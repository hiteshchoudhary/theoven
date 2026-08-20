/**
 * Publishes every package with `bun publish`.
 *
 * This replaces `changeset publish`, and the reason is a release that already went wrong.
 * `changeset publish` shells out to **npm**, and npm does not rewrite Bun's `workspace:^`
 * protocol — so 0.6.0 went to the registry with `"@theoven/core": "workspace:^"` in
 * `peerDependencies` on all 25 packages, which no installer can resolve.
 *
 * `check-publish.mjs` did not catch it, and its own docstring had described the trap for
 * months. It packed with `bun pm pack` — the tool that rewrites correctly — while the release
 * ran the tool that does not. **The guard tested a different code path than the release used**,
 * which is the only interesting thing about this bug.
 *
 * So: one tool for both. The check packs with Bun, and this publishes with Bun.
 *
 *   bun scripts/publish.mjs [--dry-run]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const PACKAGES = join(ROOT, 'packages')
const dryRun = process.argv.includes('--dry-run')

/** Asks the registry what versions exist, so a re-run skips what is already out. */
async function publishedVersions(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`)
  if (response.status === 404) return new Set()
  if (!response.ok) throw new Error(`registry said ${response.status} for ${name}`)
  const body = await response.json()
  return new Set(Object.keys(body.versions ?? {}))
}

const targets = []
for (const entry of readdirSync(PACKAGES).sort()) {
  const directory = join(PACKAGES, entry)
  const manifestPath = join(directory, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.private) continue
  targets.push({ name: manifest.name, version: manifest.version, directory })
}

const published = []
const skipped = []
const failed = []

for (const target of targets) {
  const existing = await publishedVersions(target.name)
  if (existing.has(target.version)) {
    skipped.push(`${target.name}@${target.version}`)
    continue
  }

  const result = Bun.spawnSync({
    cmd: ['bun', 'publish', ...(dryRun ? ['--dry-run'] : [])],
    cwd: target.directory,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode === 0) {
    published.push(`${target.name}@${target.version}`)
  } else {
    failed.push(`${target.name}@${target.version}: ${result.stderr.toString().trim().split('\n').at(-1)}`)
  }
}

if (skipped.length > 0) console.log(`Already published (${skipped.length}): ${skipped.join(', ')}`)
if (published.length > 0) {
  console.log(`\n${dryRun ? 'Would publish' : 'Published'} ${published.length}:`)
  for (const one of published) console.log(`  ${one}`)
}
if (failed.length > 0) {
  console.error(`\n${failed.length} failed:`)
  for (const one of failed) console.error(`  ${one}`)
  process.exit(1)
}
if (published.length === 0 && failed.length === 0) {
  console.log('\nNothing to publish.')
  process.exit(0)
}

if (dryRun) process.exit(0)

/**
 * Reads back what the registry actually stored.
 *
 * The whole point of this file is that a manifest can be correct locally and wrong once
 * published, so "it printed success" is not evidence. A first publish takes a little while to
 * become readable, hence the retries.
 */
console.log('\nVerifying against the registry...')
const bad = []
for (const target of targets) {
  let manifest
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`https://registry.npmjs.org/${target.name.replace('/', '%2F')}/${target.version}`)
    if (response.ok) {
      manifest = await response.json()
      break
    }
    await Bun.sleep(3000)
  }
  if (!manifest) {
    bad.push(`${target.name}@${target.version} is not readable from the registry`)
    continue
  }
  for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (String(range).startsWith('workspace:')) {
      bad.push(`${target.name}@${target.version} shipped ${dependency}: "${range}" — nobody can install it`)
    }
  }
}

if (bad.length > 0) {
  console.error('\nPublished, but wrong:')
  for (const one of bad) console.error(`  ${one}`)
  console.error('\nDeprecate these versions and ship a patch.')
  process.exit(1)
}
console.log(`All ${targets.length} verified: readable, with resolvable peer ranges.`)
