import { describe, expect, test } from 'bun:test'
import * as v from 'valibot'
import { z } from 'zod'
import { defineEnv, EnvError } from './env'

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
