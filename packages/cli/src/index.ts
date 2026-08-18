#!/usr/bin/env bun
import { parseArgs } from './args'
import { build } from './commands/build'
import { create } from './commands/create'
import { doctor } from './commands/doctor'
import { openapiCommand, routes } from './commands/inspect'
import { dev, start } from './commands/run'
import { BANNER, fail, info, style } from './ui'

const VERSION = '0.0.0'

const HELP = `${BANNER} ${style.dim(VERSION)}

${style.bold('Usage')}
  oven <command> [options]

${style.bold('Commands')}
  ${style.cyan('create')} <name>    scaffold a new project
  ${style.cyan('dev')}              run with a watcher
  ${style.cyan('build')}            bundle and write a route manifest
  ${style.cyan('start')}            run the build
  ${style.cyan('routes')}           print the route table
  ${style.cyan('openapi')}          emit the OpenAPI document
  ${style.cyan('doctor')}           check the project for common problems

${style.bold('Options')}
  --entry <path>     entry file          ${style.dim('(dev, start, build)')}
  --app <path>       app module          ${style.dim('(routes, openapi)')}
  --routes <path>    routes directory    ${style.dim('(build)')}
  --port <number>    port to listen on   ${style.dim('(dev, start, doctor)')}
  --outdir <path>    build output        ${style.dim('(build, default: dist)')}
  --no-minify        skip minification   ${style.dim('(build)')}
  --out <path>       write to a file     ${style.dim('(openapi)')}
  --template <name>  minimal | api       ${style.dim('(create)')}
  --yes              skip prompts        ${style.dim('(create)')}
  -h, --help         show this
  -v, --version      show the version

${style.dim('Docs: https://theoven.app/docs')}
`

/** Commands that need a module the modules themselves have not shipped yet. */
const PLANNED: Record<string, string> = {
  db: '@theoven/db',
  worker: '@theoven/queue',
  migrate: '@theoven/db',
}

export async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)

  if (args.flags.help || args.flags.h || args.command === 'help' || args.command === undefined) {
    info(HELP)
    return args.command === undefined && !args.flags.help && !args.flags.h ? 1 : 0
  }

  if (args.flags.version || args.flags.v || args.command === 'version') {
    info(VERSION)
    return 0
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
    case 'routes':
      return routes(args)
    case 'openapi':
      return openapiCommand(args)
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
