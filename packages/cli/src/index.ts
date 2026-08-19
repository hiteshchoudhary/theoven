#!/usr/bin/env bun
import { parseArgs } from './args'
import { build } from './commands/build'
import { create } from './commands/create'
import { dbCommand } from './commands/db'
import { doctor } from './commands/doctor'
import { openapiCommand, routes } from './commands/inspect'
import { dev, start } from './commands/run'
import { worker } from './commands/worker'
import { BANNER, fail, info, style } from './ui'

/**
 * Read from the manifest rather than written here.
 *
 * A hardcoded version is one someone forgets on the release that matters — the CLI printed
 * `0.0.0` from an installed 0.1.0 package, which is exactly the sort of thing that turns a bug
 * report into a wrong-version wild goose chase.
 */
const VERSION =
  ((
    await Bun.file(new URL('../package.json', import.meta.url))
      .json()
      .catch(() => ({}))
  ).version as string) ?? '0.0.0'

const HELP = `${BANNER} ${style.dim(VERSION)}

${style.bold('Usage')}
  oven <command> [options]

${style.bold('Commands')}
  ${style.cyan('create')} <name>    scaffold a new project
  ${style.cyan('dev')}              run with a watcher
  ${style.cyan('build')}            bundle and write a route manifest
  ${style.cyan('start')}            run the build
  ${style.cyan('db')} <command>    generate | migrate | push | studio
  ${style.cyan('routes')}           print the route table
  ${style.cyan('openapi')}          emit the OpenAPI document
  ${style.cyan('worker')}           run background jobs
  ${style.cyan('doctor')}           check the project for common problems

${style.bold('Options')}
  --entry <path>     entry file          ${style.dim('(dev, start, build)')}
  --app <path>       app module          ${style.dim('(routes, openapi)')}
  --routes <path>    routes directory    ${style.dim('(build)')}
  --port <number>    port to listen on   ${style.dim('(dev, start, doctor)')}
  --outdir <path>    build output        ${style.dim('(build, default: dist)')}
  --no-minify        skip minification   ${style.dim('(build)')}
  --out <path>       write to a file     ${style.dim('(openapi)')}
  --concurrency <n>  jobs at once        ${style.dim('(worker)')}
  --once             drain and exit      ${style.dim('(worker)')}
  --template <name>  minimal | api       ${style.dim('(create)')}
  --db <name>        sqlite | postgres | none  ${style.dim('(create)')}
  --auth <name>      basic | none        ${style.dim('(create)')}
  --no-openapi       skip /docs          ${style.dim('(create)')}
  --yes              skip prompts        ${style.dim('(create)')}
  -h, --help         show this
  -v, --version      show the version

${style.dim('Docs: https://theoven.app/docs')}
`

/** Commands that need a module the modules themselves have not shipped yet. */
const PLANNED: Record<string, string> = {}

export async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)

  /**
   * Version before help.
   *
   * `oven --version` has no command, and the help branch treats "no command" as "show usage" —
   * so asking for the version printed the whole help text and exited 1. Anything scripting
   * against it saw a failure.
   */
  if (args.flags.version || args.flags.v || args.command === 'version') {
    info(VERSION)
    return 0
  }

  if (args.flags.help || args.flags.h || args.command === 'help' || args.command === undefined) {
    info(HELP)
    // Asking for help succeeded. Running with no arguments at all did not — the shell should
    // see a usage error, which is what makes `oven && deploy` behave.
    return args.command === undefined && !args.flags.help && !args.flags.h ? 1 : 0
  }

  // A command that exists in the roadmap but not yet in the code should say so, rather than
  // look like a typo the user made.
  const planned = PLANNED[args.command]
  if (planned) {
    fail(
      `\`oven ${args.command}\` needs ${planned}, which is not built yet.`,
      'Track it at https://github.com/hiteshchoudhary/theoven/blob/main/TODO.md',
    )
    return 1
  }

  switch (args.command) {
    case 'create':
    case 'new':
      return create(args)
    case 'dev':
      return dev(args)
    case 'build':
      return build(args)
    case 'start':
      return start(args)
    case 'db':
      return dbCommand(args)
    case 'routes':
      return routes(args)
    case 'openapi':
      return openapiCommand(args)
    case 'worker':
      return worker(args)
    case 'doctor':
      return doctor(args)
    default:
      fail(`Unknown command "${args.command}".`, 'Run `oven --help` to see what is available.')
      return 1
  }
}

// Only run when invoked as a program, so the module can be imported by tests.
if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)))
}
