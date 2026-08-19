import { describe, expect, test } from 'bun:test'
import {
  BadRequest,
  Conflict,
  Forbidden,
  InternalServerError,
  MethodNotAllowed,
  NotFound,
  OvenError,
  PayloadTooLarge,
  ServiceUnavailable,
  TooManyRequests,
  toOvenError,
  Unauthorized,
  UnprocessableContent,
  UnsupportedMediaType,
} from './errors'

describe('OvenError', () => {
  test('is a real Error and can be caught as one', () => {
    const error = new OvenError(400, 'Bad Request')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(OvenError)
  })

  test('falls back to the title as its message', () => {
    expect(new OvenError(404, 'Not Found').message).toBe('Not Found')
  })

  test('keeps a distinct message when given one', () => {
    expect(new OvenError(404, 'Not Found', 'No user with id 7').message).toBe('No user with id 7')
  })

  test('preserves the cause', () => {
    const cause = new Error('socket closed')
    expect(new OvenError(500, 'Internal', 'wrapped', { cause }).cause).toBe(cause)
  })
})

describe('toProblem', () => {
  test('renders the RFC 9457 core members', () => {
    expect(new OvenError(404, 'Not Found').toProblem()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
    })
  })

  test('omits detail when the message only repeats the title', () => {
    expect(new OvenError(404, 'Not Found', 'Not Found').toProblem()).not.toHaveProperty('detail')
  })

  test('includes detail when the message adds something', () => {
    const problem = new OvenError(404, 'Not Found', 'No user with id 7').toProblem()
    expect(problem.detail).toBe('No user with id 7')
  })

  test('merges extension members, which is how validation reports fields', () => {
    const error = new UnprocessableContent('Validation failed', {
      detail: { errors: [{ path: 'email', message: 'invalid' }] },
    })
    expect(error.toProblem()).toMatchObject({
      status: 422,
      title: 'Unprocessable Content',
      errors: [{ path: 'email', message: 'invalid' }],
    })
  })

  test('carries a custom problem type URI', () => {
    const error = new OvenError(403, 'Forbidden', undefined, {
      type: 'https://theoven.app/problems/insufficient-scope',
    })
    expect(error.toProblem().type).toBe('https://theoven.app/problems/insufficient-scope')
  })
})

describe('error subclasses', () => {
  test.each([
    [BadRequest, 400, 'Bad Request'],
    [Unauthorized, 401, 'Unauthorized'],
    [Forbidden, 403, 'Forbidden'],
    [NotFound, 404, 'Not Found'],
    [MethodNotAllowed, 405, 'Method Not Allowed'],
    [Conflict, 409, 'Conflict'],
    [PayloadTooLarge, 413, 'Payload Too Large'],
    [UnsupportedMediaType, 415, 'Unsupported Media Type'],
    [UnprocessableContent, 422, 'Unprocessable Content'],
    [TooManyRequests, 429, 'Too Many Requests'],
    [InternalServerError, 500, 'Internal Server Error'],
    [ServiceUnavailable, 503, 'Service Unavailable'],
  ])('%p maps to %i', (Factory, status, title) => {
    const error = new Factory()
    expect(error.status).toBe(status)
    expect(error.title).toBe(title)
    expect(error).toBeInstanceOf(OvenError)
  })

  test('subclasses accept headers, which is how 405 sends Allow', () => {
    const error = new MethodNotAllowed('nope', { headers: { allow: 'GET, POST' } })
    expect(error.headers).toEqual({ allow: 'GET, POST' })
  })

  test('subclasses carry a useful name for logs', () => {
    expect(new NotFound().name).toBe('NotFound')
  })
})

describe('toOvenError', () => {
  test('passes an OvenError through unchanged', () => {
    const original = new NotFound('gone')
    expect(toOvenError(original, true)).toBe(original)
  })

  test('wraps an unknown error as a 500', () => {
    expect(toOvenError(new Error('boom'), false).status).toBe(500)
  })

  test('keeps the real message outside production, for debuggability', () => {
    expect(toOvenError(new Error('connection to db-primary failed'), false).message).toBe(
      'connection to db-primary failed',
    )
  })

  // The whole point: an unplanned error message is where connection strings leak.
  test('withholds the real message in production', () => {
    const error = toOvenError(new Error('postgres://user:hunter2@db-primary/app'), true)
    expect(error.message).toBe('An unexpected error occurred.')
    expect(error.message).not.toContain('hunter2')
  })

  test('still attaches the original as the cause so logs keep it', () => {
    const original = new Error('secret detail')
    expect(toOvenError(original, true).cause).toBe(original)
  })

  test('handles non-Error throws', () => {
    const error = toOvenError('a bare string', false)
    expect(error.status).toBe(500)
    expect(error.message).toBe('An unexpected error occurred.')
  })

  test('handles a thrown null', () => {
    expect(toOvenError(null, false).status).toBe(500)
  })
})

/**
 * RFC 9110: a 401 **MUST** carry a `WWW-Authenticate` challenge. Without one the client is told
 * it was refused but not how to authenticate, and some HTTP clients treat the response as
 * malformed rather than retrying with a credential.
 */
describe('401 carries a challenge', () => {
  test('Unauthorized sets WWW-Authenticate by default', () => {
    expect(new Unauthorized('nope').headers).toEqual({ 'www-authenticate': 'Bearer' })
  })

  // An auth provider using a different scheme must be able to say so.
  test('an explicit challenge wins', () => {
    const error = new Unauthorized('nope', {
      headers: { 'www-authenticate': 'Basic realm="admin"' },
    })
    expect(error.headers?.['www-authenticate']).toBe('Basic realm="admin"')
  })

  test('other headers are kept alongside the default', () => {
    const error = new Unauthorized('nope', { headers: { 'x-trace': 'abc' } })
    expect(error.headers).toEqual({ 'www-authenticate': 'Bearer', 'x-trace': 'abc' })
  })

  // Only 401 is required to carry one; adding it elsewhere would be noise.
  test('other statuses carry no challenge', () => {
    expect(new Forbidden('no').headers).toBeUndefined()
    expect(new NotFound('no').headers).toBeUndefined()
  })
})
