/**
 * A minimal argument parser.
 *
 * Written rather than depended on. The CLI's whole surface is a handful of flags, and a
 * dependency here would be installed by every user of `@theoven/cli` to save about forty lines.
 */

export interface ParsedArgs {
  /** The subcommand, e.g. `dev`. `undefined` when none was given. */
  command: string | undefined
  /** Everything after the command that is not a flag. */
  positionals: string[]
  /** `--flag value`, `--flag=value`, and bare `--flag` (true). `--no-flag` sets false. */
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  let command: string | undefined
  let index = 0

  for (; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue

    if (token === '--') {
      // Everything after `--` is passed through verbatim, which is how `oven db -- --flag`
      // hands flags to the tool underneath rather than eating them here.
      positionals.push(...argv.slice(index + 1))
      break
    }

    if (token.startsWith('--')) {
      const body = token.slice(2)
      const equals = body.indexOf('=')

      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1)
        continue
      }

      if (body.startsWith('no-')) {
        flags[body.slice(3)] = false
        continue
      }

      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next
        index++
      } else {
        flags[body] = true
      }
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      // Short flags are always boolean; the CLI has no short flag that takes a value, and
      // guessing would make `-p 3000` ambiguous with a positional.
      for (const letter of token.slice(1)) flags[letter] = true
      continue
    }

    if (command === undefined) command = token
    else positionals.push(token)
  }

  return { command, positionals, flags }
}

/** Reads a flag as a string, falling back when absent or boolean. */
export function stringFlag(
  flags: ParsedArgs['flags'],
  name: string,
  fallback?: string,
): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : fallback
}

/** Reads a flag as a boolean. */
export function boolFlag(flags: ParsedArgs['flags'], name: string, fallback = false): boolean {
  const value = flags[name]
  return typeof value === 'boolean' ? value : value !== undefined ? true : fallback
}
