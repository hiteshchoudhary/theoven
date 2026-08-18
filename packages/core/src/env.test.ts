import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import { z } from 'zod'
import { createEnvReader, defineEnv, EnvError, EnvReader, env, isSecretName } from './env'

describe('defineEnv', () => {
  test('returns the validated values', () => {
    const env = defineEnv(z.object({ PORT: z.coerce.number(), NAME: z.string() }), {
      source: { PORT: '3000', NAME: 'api' },
    })
    expect(env).toEqual({ PORT: 3000, NAME: 'api' })
  })

  test('coerces through the schema', () => {
    const env = defineEnv(z.object({ PORT: z.coerce.number() }), { source: { PORT: '8080' } })
    expect(typeof env.PORT).toBe('number')
  })

  test('applies defaults', () => {
    const env = defineEnv(z.object({ PORT: z.coerce.number().default(3000) }), { source: {} })
    expect(env.PORT).toBe(3000)
  })

  test('ignores extra variables', () => {
    const env = defineEnv(z.object({ A: z.string() }), { source: { A: '1', UNRELATED: 'x' } })
    expect(env).toEqual({ A: '1' })
  })

  test('skips undefined values rather than passing them through', () => {
    const env = defineEnv(z.object({ A: z.string().optional() }), {
      source: { A: undefined, B: '1' },
    })
    expect(env.A).toBeUndefined()
  })
})

// The failure this exists to prevent: `connect ECONNREFUSED undefined:undefined`, forty minutes
// into production, from a stack trace pointing at a connection pool.
describe('failures', () => {
  test('a missing variable throws', () => {
    expect(() => defineEnv(z.object({ DATABASE_URL: z.url() }), { source: {} })).toThrow(EnvError)
  })

  test('the message names the variable', () => {
    try {
      defineEnv(z.object({ DATABASE_URL: z.url() }), { source: {} })
      throw new Error('should have thrown')
    } catch (thrown) {
      expect((thrown as EnvError).message).toContain('DATABASE_URL')
    }
  })

  test('the message is formatted for a terminal', () => {
    try {
      defineEnv(z.object({ A: z.string(), B: z.string() }), { source: {} })
      throw new Error('should have thrown')
    } catch (thrown) {
      const message = (thrown as EnvError).message
      expect(message).toStartWith('Invalid environment:')
      expect(message.split('\n')).toHaveLength(3)
    }
  })

  // Fixing configuration one variable per restart is an awful way to spend twenty minutes.
  test('every problem is reported at once', () => {
    try {
      defineEnv(z.object({ A: z.string(), B: z.string(), C: z.string() }), { source: {} })
      throw new Error('should have thrown')
    } catch (thrown) {
      expect((thrown as EnvError).issues).toHaveLength(3)
    }
  })

  test('issues carry the variable and the reason separately', () => {
    try {
      defineEnv(z.object({ PORT: z.coerce.number() }), { source: { PORT: 'not-a-number' } })
      throw new Error('should have thrown')
    } catch (thrown) {
      const [issue] = (thrown as EnvError).issues
      expect(issue?.path).toBe('PORT')
      expect(issue?.message).toBeTruthy()
    }
  })

  test('a wrong-format value is caught, not just a missing one', () => {
    expect(() =>
      defineEnv(z.object({ KEY: z.string().startsWith('sk_') }), { source: { KEY: 'pk_live' } }),
    ).toThrow(/KEY/)
  })

  test('EnvError is a real Error', () => {
    const error = new EnvError([{ path: 'A', message: 'required' }])
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('EnvError')
  })
})

describe('other validators', () => {
  test('valibot works', () => {
    const env = defineEnv(v.object({ NAME: v.string() }), { source: { NAME: 'api' } })
    expect(env).toEqual({ NAME: 'api' })
  })

  test('valibot failures are reported the same way', () => {
    expect(() => defineEnv(v.object({ NAME: v.string() }), { source: {} })).toThrow(EnvError)
  })
})

// An async check would let the rest of the module run before the environment was verified,
// which defeats the entire point of validating at boot.
describe('synchronous by design', () => {
  test('an async schema is rejected rather than silently awaited', () => {
    const asyncSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: async () => ({ value: {} }),
      },
    }
    expect(() => defineEnv(asyncSchema, { source: {} })).toThrow(/synchronous/)
  })
})

// ---------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------

/** A reader over a fixed source, so tests never touch the real environment. */
function reader(source: Record<string, string | undefined>) {
  return createEnvReader(source)
}

describe('strings', () => {
  test('reads a value', () => {
    expect(reader({ NAME: 'api' }).string('NAME')).toBe('api')
  })

  // Trailing spaces in a .env file are invisible and cause baffling failures.
  test('trims whitespace', () => {
    expect(reader({ NAME: '  api  ' }).string('NAME')).toBe('api')
  })

  test('uses the fallback when unset', () => {
    expect(reader({}).string('NAME', 'default')).toBe('default')
  })

  test('treats an empty value as unset', () => {
    expect(reader({ NAME: '' }).string('NAME', 'default')).toBe('default')
    expect(reader({ NAME: '   ' }).string('NAME', 'default')).toBe('default')
  })

  test('throws when required and unset, naming the variable', () => {
    expect(() => reader({}).string('DATABASE_URL')).toThrow(/DATABASE_URL/)
  })

  test('optional never throws', () => {
    expect(reader({}).optional('NAME')).toBeUndefined()
    expect(reader({ NAME: 'x' }).optional('NAME')).toBe('x')
  })

  test('raw returns the value untouched', () => {
    expect(reader({ NAME: '  spaced  ' }).raw('NAME')).toBe('  spaced  ')
  })

  test('has reports presence, treating empty as absent', () => {
    const env = reader({ SET: 'x', EMPTY: '' })
    expect(env.has('SET')).toBe(true)
    expect(env.has('EMPTY')).toBe(false)
    expect(env.has('MISSING')).toBe(false)
  })
})

// Number('') is 0 and parseInt('12abc') is 12. Both are silently wrong in exactly the way an
// environment variable is silently wrong.
describe('numbers', () => {
  test('parses a number', () => {
    expect(reader({ PORT: '3000' }).number('PORT')).toBe(3000)
  })

  test('parses a float', () => {
    expect(reader({ RATIO: '0.5' }).number('RATIO')).toBe(0.5)
  })

  test('an empty value is not zero', () => {
    expect(() => reader({ PORT: '' }).number('PORT')).toThrow(/PORT/)
  })

  test('a partly-numeric value is rejected rather than truncated', () => {
    expect(() => reader({ PORT: '12abc' }).number('PORT')).toThrow(/expected a number/)
  })

  test('rejects non-finite values', () => {
    expect(() => reader({ N: 'Infinity' }).number('N')).toThrow(/expected a number/)
    expect(() => reader({ N: 'NaN' }).number('N')).toThrow(/expected a number/)
  })

  test('uses the fallback when unset', () => {
    expect(reader({}).number('PORT', 3000)).toBe(3000)
  })

  test('int rejects a fractional value rather than rounding it', () => {
    expect(() => reader({ COUNT: '1.5' }).int('COUNT')).toThrow(/an integer/)
  })

  test('int accepts a whole number', () => {
    expect(reader({ COUNT: '42' }).int('COUNT')).toBe(42)
  })
})

// Boolean('false') is true. This is the one that turns debug logging on in production.
describe('booleans', () => {
  test.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['y', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['n', false],
    ['off', false],
  ])('%s -> %p', (raw, expected) => {
    expect(reader({ DEBUG: raw }).bool('DEBUG')).toBe(expected)
  })

  test('DEBUG=false is false, not truthy', () => {
    expect(reader({ DEBUG: 'false' }).bool('DEBUG')).toBe(false)
    expect(Boolean('false')).toBe(true)
  })

  // A typo must not silently mean "on".
  test('an unrecognised value throws rather than being truthy', () => {
    expect(() => reader({ DEBUG: 'flase' }).bool('DEBUG')).toThrow(/a boolean/)
    expect(() => reader({ DEBUG: 'maybe' }).bool('DEBUG')).toThrow(/DEBUG/)
  })

  test('uses the fallback when unset', () => {
    expect(reader({}).bool('DEBUG', true)).toBe(true)
    expect(reader({}).bool('DEBUG', false)).toBe(false)
  })

  test('throws when required and unset', () => {
    expect(() => reader({}).bool('DEBUG')).toThrow(/DEBUG/)
  })
})

describe('ports', () => {
  test('accepts a valid port', () => {
    expect(reader({ PORT: '8080' }).port('PORT')).toBe(8080)
  })

  test.each(['0', '65536', '-1'])('rejects %s', (raw) => {
    expect(() => reader({ PORT: raw }).port('PORT')).toThrow(/between 1 and 65535/)
  })

  test('uses the fallback', () => {
    expect(reader({}).port('PORT', 3000)).toBe(3000)
  })
})

describe('urls', () => {
  test('accepts a valid URL', () => {
    expect(reader({ API: 'https://api.example' }).url('API')).toBe('https://api.example')
  })

  test('rejects a malformed URL', () => {
    expect(() => reader({ API: 'not a url' }).url('API')).toThrow(/a valid URL/)
  })
})

describe('lists', () => {
  test('splits on commas and trims', () => {
    expect(reader({ ORIGINS: 'a.com, b.com ,c.com' }).list('ORIGINS')).toEqual([
      'a.com',
      'b.com',
      'c.com',
    ])
  })

  test('drops empty entries', () => {
    expect(reader({ ORIGINS: 'a,,b,' }).list('ORIGINS')).toEqual(['a', 'b'])
  })

  test('a single value is a one-item list', () => {
    expect(reader({ ORIGINS: 'a.com' }).list('ORIGINS')).toEqual(['a.com'])
  })

  test('uses the fallback when unset', () => {
    expect(reader({}).list('ORIGINS', [])).toEqual([])
  })
})

describe('oneOf', () => {
  test('accepts a listed value', () => {
    expect(reader({ LEVEL: 'warn' }).oneOf('LEVEL', ['debug', 'info', 'warn'])).toBe('warn')
  })

  test('names the alternatives when it does not match', () => {
    expect(() => reader({ LEVEL: 'verbose' }).oneOf('LEVEL', ['debug', 'info'])).toThrow(
      /debug, info/,
    )
  })

  test('uses the fallback', () => {
    expect(reader({}).oneOf('LEVEL', ['debug', 'info'], 'info')).toBe('info')
  })
})

// TIMEOUT=30 is ambiguous in a way TIMEOUT=30s is not.
describe('durations', () => {
  test.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['5m', 300_000],
    ['1h', 3_600_000],
    ['2d', 172_800_000],
    ['1500', 1500],
    ['1.5s', 1500],
    ['30 s', 30_000],
  ])('%s -> %i ms', (raw, expected) => {
    expect(reader({ TIMEOUT: raw }).duration('TIMEOUT')).toBe(expected)
  })

  test('rejects an unknown unit', () => {
    expect(() => reader({ TIMEOUT: '5 fortnights' }).duration('TIMEOUT')).toThrow(/TIMEOUT/)
  })

  test('accepts a string fallback', () => {
    expect(reader({}).duration('TIMEOUT', '30s')).toBe(30_000)
  })

  test('accepts a numeric fallback', () => {
    expect(reader({}).duration('TIMEOUT', 5000)).toBe(5000)
  })
})

describe('byte sizes', () => {
  test.each([
    ['1024', 1024],
    ['1kb', 1024],
    ['8mb', 8_388_608],
    ['1gb', 1_073_741_824],
    ['512kb', 524_288],
  ])('%s -> %i bytes', (raw, expected) => {
    expect(reader({ MAX: raw }).bytes('MAX')).toBe(expected)
  })

  test('units are binary, matching every size limit in the framework', () => {
    expect(reader({ MAX: '1kb' }).bytes('MAX')).toBe(1024)
  })

  test('accepts a string fallback', () => {
    expect(reader({}).bytes('MAX', '8mb')).toBe(8_388_608)
  })
})

describe('NODE_ENV helpers', () => {
  test('defaults to development', () => {
    expect(reader({}).nodeEnv).toBe('development')
    expect(reader({}).isDevelopment).toBe(true)
  })

  test('reads production', () => {
    const env = reader({ NODE_ENV: 'production' })
    expect(env.isProduction).toBe(true)
    expect(env.isDevelopment).toBe(false)
  })

  test('reads test', () => {
    expect(reader({ NODE_ENV: 'test' }).isTest).toBe(true)
  })
})

/**
 * The reason anyone dumps the environment is to put it somewhere they can read later — a log,
 * an error report, a support ticket. Redaction is the default for that reason.
 */
describe('secret redaction', () => {
  test.each([
    'DATABASE_URL',
    'STRIPE_SECRET_KEY',
    'API_TOKEN',
    'JWT_SECRET',
    'DB_PASSWORD',
    'PRIVATE_KEY',
    'SESSION_SALT',
    'REDIS_CONNECTION_STRING',
    'aws_secret_access_key',
  ])('%s is treated as a secret', (name) => {
    expect(isSecretName(name)).toBe(true)
  })

  test.each(['PORT', 'NODE_ENV', 'LOG_LEVEL', 'APP_NAME'])('%s is not', (name) => {
    expect(isSecretName(name)).toBe(false)
  })

  test('all() redacts secret values', () => {
    const dumped = reader({ PORT: '3000', DATABASE_URL: 'postgres://u:hunter2@db/app' }).all()
    expect(dumped.PORT).toBe('3000')
    expect(dumped.DATABASE_URL).toBe('[redacted]')
  })

  test('all() output contains no secret material at all', () => {
    const dumped = reader({ STRIPE_KEY: 'sk_live_abc123', SAFE: 'ok' }).all()
    expect(JSON.stringify(dumped)).not.toContain('sk_live_abc123')
  })

  // The error path is the likeliest place for a secret to escape.
  test('an invalid secret is not echoed in the error', () => {
    // A malformed connection string still contains the password. Naming the variable is
    // necessary; quoting the value back is how it reaches a log.
    const broken = 'postgres//user:hunter2@host/db'

    expect(() => reader({ DATABASE_URL: broken }).url('DATABASE_URL')).toThrow(/DATABASE_URL/)
    expect(() => reader({ DATABASE_URL: broken }).url('DATABASE_URL')).toThrow(/\[redacted\]/)
    expect(() => reader({ DATABASE_URL: broken }).url('DATABASE_URL')).not.toThrow(/hunter2/)
  })

  test('a non-secret invalid value is shown, since seeing it is the point', () => {
    try {
      reader({ PORT: '12abc' }).number('PORT')
      throw new Error('should have thrown')
    } catch (thrown) {
      expect((thrown as Error).message).toContain('12abc')
    }
  })
})

describe('the default reader', () => {
  test('reads the real environment', () => {
    expect(env.nodeEnv).toBeTruthy()
  })

  test('is an EnvReader', () => {
    expect(env).toBeInstanceOf(EnvReader)
  })
})
