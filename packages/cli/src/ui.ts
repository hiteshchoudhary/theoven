/**
 * Terminal output.
 *
 * Colour is disabled when stdout is not a TTY, when `NO_COLOR` is set, or when `FORCE_COLOR=0`.
 * A CLI whose output is piped into a log file should not fill it with escape sequences.
 */
const ESC = '\u001b'
const enabled =
  Bun.env.NO_COLOR === undefined && Bun.env.FORCE_COLOR !== '0' && process.stdout.isTTY === true

function paint(code: string): (text: string) => string {
  return (text) => (enabled ? `${ESC}[${code}m${text}${ESC}[0m` : text)
}

export const style = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  ember: paint('38;5;208'),
}

export function info(message: string): void {
  console.log(message)
}

export function success(message: string): void {
  console.log(`${style.green('✓')} ${message}`)
}

export function warn(message: string): void {
  console.warn(`${style.yellow('!')} ${message}`)
}

/** Prints an error and its guidance. Never throws — the caller decides the exit code. */
export function fail(message: string, hint?: string): void {
  console.error(`${style.red('✗')} ${message}`)
  if (hint) console.error(`  ${style.dim(hint)}`)
}

/** Renders a route table, aligned and sorted for scanning. */
export function routeTable(routes: ReadonlyArray<{ method: string; pattern: string }>): string {
  if (routes.length === 0) return style.dim('  (no routes)')

  const width = Math.max(...routes.map((route) => route.method.length))
  const order = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

  return [...routes]
    .sort(
      (a, b) =>
        a.pattern.localeCompare(b.pattern) || order.indexOf(a.method) - order.indexOf(b.method),
    )
    .map((route) => `  ${style.cyan(route.method.padEnd(width))}  ${route.pattern}`)
    .join('\n')
}

export const BANNER = `${style.ember('▲')} ${style.bold('Oven')}`
