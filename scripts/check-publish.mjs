/**
 * Packs every publishable package and checks what npm would actually receive.
 *
 * This exists because the failure it catches is silent and total: `workspace:^` is a protocol
 * npm does not understand, and a single one leaking into a published `peerDependencies` makes
 * every `bun add`/`npm i` fail with EUNSUPPORTEDPROTOCOL. `bun pm pack` rewrites it; `npm
 * publish` does not — so whether a release is broken depends on which tool ran, which is exactly
 * the sort of thing nobody checks until the bug reports arrive.
 *
 *   bun scripts/check-publish.mjs
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const PACKAGES = join(ROOT, 'packages')

const problems = []
const versions = new Map()

for (const name of readdirSync(PACKAGES).sort()) {
  const directory = join(PACKAGES, name)
  const manifestPath = join(directory, 'package.json')
  if (!existsSync(manifestPath)) continue

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.private) continue

  const out = await mkdtemp(join(tmpdir(), 'oven-pack-'))

  const packed = Bun.spawnSync(['bun', 'pm', 'pack', '--destination', out], { cwd: directory })
  if (packed.exitCode !== 0) {
    problems.push(`${manifest.name}: pack failed — ${packed.stderr.toString().trim()}`)
    continue
  }

  const tarball = readdirSync(out).find((file) => file.endsWith('.tgz'))
  if (!tarball) {
    problems.push(`${manifest.name}: pack produced no tarball`)
    continue
  }

  const extracted = Bun.spawnSync(['tar', '-xzf', join(out, tarball), '-C', out])
  if (extracted.exitCode !== 0) {
    problems.push(`${manifest.name}: could not read its own tarball`)
    continue
  }

  const shipped = JSON.parse(readFileSync(join(out, 'package', 'package.json'), 'utf8'))
  const listing = Bun.spawnSync(['tar', '-tzf', join(out, tarball)]).stdout.toString().split('\n')

  versions.set(manifest.name, shipped.version)

  // The one that breaks every install.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(shipped[field] ?? {})) {
      if (String(range).startsWith('workspace:')) {
        problems.push(
          `${manifest.name}: ${field}.${dependency} is "${range}". npm cannot resolve that — ` +
            'publish with `bun publish`, not `npm publish`.',
        )
      }
    }
  }

  // Tests pull devDependencies a consumer does not have, and are dead weight in every install.
  const tests = listing.filter((file) => /\.test\.[jt]sx?$/.test(file))
  if (tests.length > 0) {
    problems.push(`${manifest.name}: ships ${tests.length} test file(s), e.g. ${tests[0]}`)
  }

  // A README is the npm landing page. A package without one is a package nobody installs.
  for (const required of ['package/README.md', 'package/LICENSE']) {
    if (!listing.includes(required)) problems.push(`${manifest.name}: missing ${required}`)
  }

  if (!shipped.repository?.directory) {
    problems.push(`${manifest.name}: no repository.directory, so npm cannot link to the source`)
  }

  // Every export has to resolve inside the tarball, or the package installs and cannot import.
  for (const [subpath, target] of Object.entries(shipped.exports ?? {})) {
    const file = `package/${String(target).replace(/^\.\//, '')}`
    if (!listing.includes(file)) {
      problems.push(`${manifest.name}: exports["${subpath}"] → ${target}, which is not in the tarball`)
    }
  }

  if (shipped.bin) {
    for (const [command, target] of Object.entries(shipped.bin)) {
      const file = `package/${String(target).replace(/^\.\//, '')}`
      if (!listing.includes(file)) {
        problems.push(`${manifest.name}: bin.${command} → ${target}, which is not in the tarball`)
      }
    }
  }

  rmSync(out, { recursive: true, force: true })
  console.log(`  ${shipped.name}@${shipped.version} — ${listing.filter(Boolean).length} files`)
}

// Not a rule npm enforces, but this repo releases in lockstep, and a straggler on an old version
// means someone's install resolves a peer range to a package that predates the API it needs.
const distinct = new Set(versions.values())
if (distinct.size > 1) {
  problems.push(`packages disagree on their version: ${[...distinct].sort().join(', ')}`)
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) with what would be published:\n`)
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}

console.log(`\nAll ${versions.size} packages are publishable at ${[...distinct][0]}.`)
