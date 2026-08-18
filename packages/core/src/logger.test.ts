import { describe, expect, test } from 'bun:test'
import { ConsoleLogger, type LogLevel, silentLogger } from './logger'

/** Builds a JSON logger that captures lines instead of writing to stdout. */
function capture(level: LogLevel = 'debug') {
  const lines: string[] = []
  const logger = new ConsoleLogger({ level, format: 'json', write: (line) => lines.push(line) })
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line)) }
}

describe('levels', () => {
  test('emits every level at debug', () => {
    const { logger, lines } = capture('debug')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(lines).toHaveLength(4)
  })

  test('suppresses below the threshold', () => {
    const { logger, parsed } = capture('warn')
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(parsed().map((line) => line.level)).toEqual(['warn', 'error'])
  })

  test('silent suppresses everything', () => {
    const { logger, lines } = capture('silent')
    logger.error('e')
    expect(lines).toHaveLength(0)
  })

  test('defaults to info', () => {
    const lines: string[] = []
    const logger = new ConsoleLogger({ format: 'json', write: (line) => lines.push(line) })
    logger.debug('hidden')
    logger.info('shown')
    expect(lines).toHaveLength(1)
  })
})

describe('json format', () => {
  test('emits level, message and an ISO timestamp', () => {
    const { logger, parsed } = capture()
    logger.info('server started')
    const [line] = parsed()
    expect(line.level).toBe('info')
    expect(line.message).toBe('server started')
    expect(new Date(line.time).toISOString()).toBe(line.time)
  })

  test('merges structured fields', () => {
    const { logger, parsed } = capture()
    logger.info('request', { method: 'GET', status: 200 })
    expect(parsed()[0]).toMatchObject({ method: 'GET', status: 200 })
  })

  test('produces one parseable line per call', () => {
    const { logger, lines } = capture()
    logger.info('a')
    logger.info('b')
    expect(lines).toHaveLength(2)
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow()
  })
})

describe('child loggers', () => {
  test('stamps bound fields onto every line', () => {
    const { logger, parsed } = capture()
    const child = logger.child({ requestId: 'req-1' })
    child.info('handling')
    child.warn('slow')
    expect(parsed().every((line) => line.requestId === 'req-1')).toBe(true)
  })

  test('does not leak bound fields back to the parent', () => {
    const { logger, parsed } = capture()
    logger.child({ requestId: 'req-1' }).info('child')
    logger.info('parent')
    expect(parsed()[1]).not.toHaveProperty('requestId')
  })

  test('nests, accumulating fields', () => {
    const { logger, parsed } = capture()
    logger.child({ requestId: 'req-1' }).child({ userId: 'u-9' }).info('nested')
    expect(parsed()[0]).toMatchObject({ requestId: 'req-1', userId: 'u-9' })
  })

  test('per-call fields override bound ones', () => {
    const { logger, parsed } = capture()
    logger.child({ scope: 'outer' }).info('x', { scope: 'inner' })
    expect(parsed()[0].scope).toBe('inner')
  })

  test('inherits the level threshold', () => {
    const { logger, lines } = capture('error')
    logger.child({ a: 1 }).info('suppressed')
    expect(lines).toHaveLength(0)
  })

  test('inherits the write target', () => {
    const { logger, lines } = capture()
    logger.child({ a: 1 }).info('captured')
    expect(lines).toHaveLength(1)
  })
})

describe('pretty format', () => {
  test('writes a human-readable line rather than JSON', () => {
    const lines: string[] = []
    const logger = new ConsoleLogger({
      level: 'debug',
      format: 'pretty',
      write: (line) => lines.push(line),
    })
    logger.info('hello', { requestId: 'req-1' })
    expect(lines[0]).toContain('INFO')
    expect(lines[0]).toContain('hello')
    expect(lines[0]).toContain('requestId=req-1')
    expect(() => JSON.parse(lines[0] as string)).toThrow()
  })
})

describe('field serialisation', () => {
  test('renders an Error by its message', () => {
    const lines: string[] = []
    const logger = new ConsoleLogger({ format: 'pretty', write: (line) => lines.push(line) })
    logger.error('failed', { cause: new Error('socket closed') })
    expect(lines[0]).toContain('socket closed')
  })

  test('survives a circular structure instead of throwing', () => {
    const lines: string[] = []
    const logger = new ConsoleLogger({ format: 'pretty', write: (line) => lines.push(line) })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => logger.info('circular', { circular })).not.toThrow()
    expect(lines).toHaveLength(1)
  })
})

describe('silentLogger', () => {
  test('discards everything without throwing', () => {
    expect(() => {
      silentLogger.debug('d')
      silentLogger.info('i')
      silentLogger.warn('w')
      silentLogger.error('e')
    }).not.toThrow()
  })

  test('children are also silent', () => {
    expect(silentLogger.child({ a: 1 })).toBe(silentLogger)
  })
})
