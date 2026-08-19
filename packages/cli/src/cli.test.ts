import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boolFlag, parseArgs, stringFlag } from './args'
import { checkTarget, validateProjectName } from './commands/create'
import {
  checkAppModule,
  checkBunVersion,
  checkEntry,
  checkEnvFile,
  checkRoutes,
  compareVersions,
  MINIMUM_BUN,
} from './commands/doctor'
import { looksLikeApp } from './load'
import { CANDIDATES, resolveAppModule, resolveEntry, resolveRoutesDir } from './paths'
import { renderTemplate, TEMPLATES } from './templates'
import { routeTable } from './ui'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Creates a throwaway project tree and returns its root. */
async function project(files: Record<string, string> = {}): Promise<string> {
  const root = join(
    import.meta.dir,
    '../../../.tmp',
    `cli-${Math.floor(performance.now() * 1000)}-${temporary.length}`,
  )
  temporary.push(root)
  await mkdir(root, { recursive: true })

  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, contents)
  }
  return root
}

describe('parseArgs', () => {
  test('reads a bare command', () => {
    expect(parseArgs(['dev'])).toEqual({ command: 'dev', positionals: [], flags: {} })
  })

  test('reads positionals after the command', () => {
    expect(parseArgs(['create', 'my-app']).positionals).toEqual(['my-app'])
  })

  test('reads --flag value', () => {
    expect(parseArgs(['dev', '--port', '4000']).flags).toEqual({ port: '4000' })
  })

  test('reads --flag=value', () => {
    expect(parseArgs(['dev', '--port=4000']).flags).toEqual({ port: '4000' })
  })

  test('a value-less flag is true', () => {
    expect(parseArgs(['create', '--yes']).flags).toEqual({ yes: true })
  })

  test('--no-flag is false', () => {
    expect(parseArgs(['build', '--no-minify']).flags).toEqual({ minify: false })
  })

  test('a flag followed by another flag stays boolean', () => {
    expect(parseArgs(['build', '--minify', '--outdir', 'out']).flags).toEqual({
      minify: true,
      outdir: 'out',
    })
  })

  test('short flags are boolean and can be grouped', () => {
    expect(parseArgs(['-hv']).flags).toEqual({ h: true, v: true })
  })

  // `oven db -- --flag` must hand the flag to the tool underneath, not eat it here.
  test('everything after -- is passed through verbatim', () => {
    const parsed = parseArgs(['db', 'migrate', '--', '--config', 'x'])
    expect(parsed.command).toBe('db')
    expect(parsed.positionals).toEqual(['migrate', '--config', 'x'])
  })

  test('handles no arguments', () => {
    expect(parseArgs([])).toEqual({ command: undefined, positionals: [], flags: {} })
  })

  test('a negative-looking value is still read as a value', () => {
    expect(parseArgs(['x', '--offset=-5']).flags).toEqual({ offset: '-5' })
  })
})

describe('flag readers', () => {
  test('stringFlag returns strings and falls back otherwise', () => {
    expect(stringFlag({ a: 'x' }, 'a')).toBe('x')
    expect(stringFlag({ a: true }, 'a', 'fallback')).toBe('fallback')
    expect(stringFlag({}, 'a')).toBeUndefined()
  })

  test('boolFlag reads booleans and presence', () => {
    expect(boolFlag({ a: true }, 'a')).toBe(true)
    expect(boolFlag({ a: false }, 'a', true)).toBe(false)
    expect(boolFlag({ a: 'yes' }, 'a')).toBe(true)
    expect(boolFlag({}, 'a', true)).toBe(true)
  })
})

describe('path resolution', () => {
  test('finds an entry', async () => {
    const root = await project({ 'src/index.ts': '' })
    expect(resolveEntry(root)).toBe(join(root, 'src/index.ts'))
  })

  test('prefers the first candidate', async () => {
    const root = await project({ 'src/index.ts': '', 'index.ts': '' })
    expect(resolveEntry(root)).toBe(join(root, 'src/index.ts'))
  })

  test('honours an override', async () => {
    const root = await project({ 'custom/start.ts': '' })
    expect(resolveEntry(root, 'custom/start.ts')).toBe(join(root, 'custom/start.ts'))
  })

  test('returns undefined when nothing matches', async () => {
    expect(resolveEntry(await project())).toBeUndefined()
  })

  // Inspecting an app must not bind a port, which is why these are separate lookups.
  test('the app module is looked for separately from the entry', async () => {
    const root = await project({ 'src/app.ts': '', 'src/index.ts': '' })
    expect(resolveAppModule(root)).toBe(join(root, 'src/app.ts'))
    expect(resolveEntry(root)).toBe(join(root, 'src/index.ts'))
    expect(CANDIDATES.app).not.toContain('src/index.ts')
  })

  test('finds a routes directory', async () => {
    const root = await project({ 'src/routes/index.get.ts': '' })
    expect(resolveRoutesDir(root)).toBe(join(root, 'src/routes'))
  })
})

describe('doctor checks', () => {
  test.each([
    ['1.2.23', '1.2.0', 1],
    ['1.2.0', '1.2.0', 0],
    ['1.1.9', '1.2.0', -1],
    ['2.0.0', '1.9.9', 1],
    ['1.2', '1.2.0', 0],
  ])('compareVersions(%s, %s) = %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  test('accepts a supported Bun', () => {
    expect(checkBunVersion('1.2.23').status).toBe('ok')
  })

  test('rejects an old Bun and says how to fix it', () => {
    const result = checkBunVersion('1.0.0')
    expect(result.status).toBe('fail')
    expect(result.hint).toContain('bun upgrade')
    expect(result.detail).toContain(MINIMUM_BUN)
  })

  test('a missing entry fails and lists the candidates', async () => {
    const result = checkEntry(await project())
    expect(result.status).toBe('fail')
    expect(result.hint).toContain('src/index.ts')
  })

  test('a present entry passes', async () => {
    expect(checkEntry(await project({ 'src/index.ts': '' })).status).toBe('ok')
  })

  // Only a warning: programmatic routes work fine without an app module.
  test('a missing app module warns rather than failing', async () => {
    const result = checkAppModule(await project({ 'src/index.ts': '' }))
    expect(result.status).toBe('warn')
    expect(result.hint).toContain('listen()')
  })

  test('a missing routes directory warns', async () => {
    expect(checkRoutes(await project()).status).toBe('warn')
  })

  test('a .env without a .env.example warns', async () => {
    const result = checkEnvFile(await project({ '.env': 'A=1' }))
    expect(result.status).toBe('warn')
    expect(result.hint).toContain('.env.example')
  })

  test('a .env.example without a .env explains the copy', async () => {
    const result = checkEnvFile(await project({ '.env.example': 'A=1' }))
    expect(result.status).toBe('warn')
    expect(result.hint).toContain('cp .env.example .env')
  })

  test('both present is fine', async () => {
    const root = await project({ '.env': 'A=1', '.env.example': 'A=' })
    expect(checkEnvFile(root).status).toBe('ok')
  })

  test('neither present is fine', async () => {
    expect(checkEnvFile(await project()).status).toBe('ok')
  })

  test('every non-ok check explains what to do', async () => {
    const root = await project()
    for (const result of [checkEntry(root), checkAppModule(root), checkRoutes(root)]) {
      if (result.status !== 'ok') expect(result.hint).toBeTruthy()
    }
  })
})

describe('project names', () => {
  test.each(['my-app', 'api', 'a1', 'my.app', 'my_app'])('%s is valid', (name) => {
    expect(validateProjectName(name)).toBeNull()
  })

  test.each([
    ['', 'required'],
    ['My-App', 'lowercase'],
    ['.hidden', 'cannot start'],
    ['_private', 'cannot start'],
    ['has space', 'lowercase'],
    ['has/slash', 'lowercase'],
  ])('%s is rejected', (name, fragment) => {
    expect(validateProjectName(name)).toContain(fragment)
  })

  test('rejects an absurdly long name', () => {
    expect(validateProjectName('a'.repeat(300))).toContain('214')
  })
})

describe('scaffold target', () => {
  test('a fresh directory is fine', async () => {
    expect(await checkTarget(join(await project(), 'new-thing'))).toBeNull()
  })

  test('an empty directory is fine', async () => {
    expect(await checkTarget(await project())).toBeNull()
  })

  // Overwriting someone's work silently is unforgivable in a scaffolder.
  test('a non-empty directory is refused', async () => {
    const root = await project({ 'existing.ts': 'work' })
    expect(await checkTarget(root)).toContain('not empty')
  })

  test('a directory holding only .git is fine, since git init comes first for many people', async () => {
    const root = await project({ '.git/HEAD': 'ref: refs/heads/main' })
    expect(await checkTarget(root)).toBeNull()
  })
})

describe('templates', () => {
  test('minimal produces a runnable skeleton', () => {
    const files = renderTemplate('minimal', { name: 'test-app', openapi: true })
    const paths = files.map((file) => file.path)

    expect(paths).toContain('package.json')
    expect(paths).toContain('src/app.ts')
    expect(paths).toContain('src/index.ts')
    expect(paths).toContain('src/routes/index.get.ts')
  })

  test('api adds a resource with validation', () => {
    const paths = renderTemplate('api', { name: 'test-app', openapi: true }).map((f) => f.path)
    expect(paths).toContain('src/routes/users/index.get.ts')
    expect(paths).toContain('src/routes/users/[id].get.ts')
    expect(paths).toContain('src/routes/users/_store.ts')
  })

  // The split is what lets `oven routes` inspect the app without starting a server.
  test('app.ts exports without listening; index.ts listens', () => {
    const files = renderTemplate('api', { name: 'test-app', openapi: true })
    const app = files.find((file) => file.path === 'src/app.ts')?.contents ?? ''
    const entry = files.find((file) => file.path === 'src/index.ts')?.contents ?? ''

    expect(app).toContain('export default app')
    // Matched on the call, not an exact string: the entry passes a port, and the invariant is
    // "the entry listens and the app module does not", not the argument list.
    expect(app).not.toContain('app.listen(')
    expect(entry).toContain('app.listen(')
  })

  test('config is read in one place and used by both', () => {
    const files = renderTemplate('api', { name: 'test-app', openapi: true })
    const paths = files.map((file) => file.path)
    expect(paths).toContain('src/env.ts')

    const envModule = files.find((file) => file.path === 'src/env.ts')?.contents ?? ''
    expect(envModule).toContain('env.port(')
    // A bad variable must read as a config error, not as a stack through library internals.
    expect(envModule).toContain('EnvError')
    expect(envModule).toContain('process.exit(1)')
  })

  test('.env.example lists what the scaffold reads', () => {
    const files = renderTemplate('api', { name: 'test-app', openapi: true })
    const example = files.find((file) => file.path === '.env.example')?.contents ?? ''
    expect(example).toContain('PORT=')
    expect(example).toContain('LOG_LEVEL=')
  })

  test('the openapi brick is included or omitted as asked', () => {
    const withDocs = renderTemplate('api', { name: 'a', openapi: true })
    const without = renderTemplate('api', { name: 'a', openapi: false })

    const appOf = (files: ReturnType<typeof renderTemplate>) =>
      files.find((file) => file.path === 'src/app.ts')?.contents ?? ''

    expect(appOf(withDocs)).toContain('openapi(')
    expect(appOf(without)).not.toContain('openapi(')
  })

  test('the package name matches the project', () => {
    const files = renderTemplate('minimal', { name: 'my-service', openapi: true })
    const pkg = files.find((file) => file.path === 'package.json')?.contents ?? ''
    expect(JSON.parse(pkg).name).toBe('my-service')
  })

  test('package.json is valid JSON', () => {
    for (const template of Object.keys(TEMPLATES) as Array<'minimal' | 'api'>) {
      const files = renderTemplate(template, { name: 'x', openapi: true })
      const pkg = files.find((file) => file.path === 'package.json')?.contents ?? ''
      expect(() => JSON.parse(pkg)).not.toThrow()
    }
  })

  test('tsconfig is valid JSON and strict', () => {
    const files = renderTemplate('minimal', { name: 'x', openapi: true })
    const tsconfig = files.find((file) => file.path === 'tsconfig.json')?.contents ?? ''
    expect(JSON.parse(tsconfig).compilerOptions.strict).toBe(true)
  })

  test('gitignore covers build output and secrets', () => {
    const files = renderTemplate('minimal', { name: 'x', openapi: true })
    const ignore = files.find((file) => file.path === '.gitignore')?.contents ?? ''
    expect(ignore).toContain('dist/')
    expect(ignore).toContain('.oven/')
    expect(ignore).toContain('.env')
  })

  test('no template file is empty', () => {
    for (const template of Object.keys(TEMPLATES) as Array<'minimal' | 'api'>) {
      for (const file of renderTemplate(template, { name: 'x', openapi: true })) {
        expect(file.contents.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('app detection', () => {
  test('recognises something with the app shape', () => {
    expect(looksLikeApp({ routes: () => [], routeTable: () => [] })).toBe(true)
  })

  test.each([[null], [undefined], ['a string'], [{}], [{ routes: () => [] }]])(
    'rejects %p',
    (value) => {
      expect(looksLikeApp(value)).toBe(false)
    },
  )
})

describe('routeTable rendering', () => {
  test('aligns methods and sorts by path', () => {
    const output = routeTable([
      { method: 'POST', pattern: '/users' },
      { method: 'GET', pattern: '/health' },
      { method: 'GET', pattern: '/users' },
    ])
    const lines = output.split('\n')

    expect(lines[0]).toContain('/health')
    expect(lines[1]).toContain('/users')
    expect(lines).toHaveLength(3)
  })

  test('says so when there are none', () => {
    expect(routeTable([])).toContain('no routes')
  })
})
