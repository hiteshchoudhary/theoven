/**
 * AWS Signature Version 4, for the SES driver.
 *
 * Written rather than depended on. `Bun.S3Client` signs S3 requests but exposes no general
 * signer, and the AWS SDK is a very large dependency to acquire in order to send an email.
 * This is the whole algorithm as it applies to a signed POST with a body — about eighty lines,
 * deterministic, and checkable against AWS's own published test vectors, which is what the
 * tests do.
 */

export interface SignOptions {
  method: string
  url: URL
  headers: Record<string, string>
  body: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | undefined
  /** Injected by the tests, which compare against AWS's fixed-timestamp vectors. */
  now?: Date | undefined
}

function sha256Hex(value: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

function hmac(key: Uint8Array | string, value: string): Uint8Array {
  return new Uint8Array(
    new Bun.CryptoHasher('sha256', key as never).update(value).digest() as unknown as ArrayBuffer,
  )
}

/**
 * Each part of the URI path is encoded, but the separators are not.
 *
 * AWS's own rule, and the reason `encodeURIComponent` alone is wrong here.
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/')
}

/** Query parameters, sorted by name then value, each encoded. */
function canonicalQuery(url: URL): string {
  const parameters: Array<[string, string]> = []
  for (const [name, value] of url.searchParams) parameters.push([name, value])

  parameters.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))

  return parameters
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&')
}

/** Signs a request, returning the headers to send. */
export function signRequest(options: SignOptions): Record<string, string> {
  const now = options.now ?? new Date()
  const amzDate = `${now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '')
    .slice(0, 15)}Z`
  const dateStamp = amzDate.slice(0, 8)

  const headers: Record<string, string> = {
    ...options.headers,
    host: options.url.host,
    'x-amz-date': amzDate,
    ...(options.sessionToken ? { 'x-amz-security-token': options.sessionToken } : {}),
  }

  // Header names lowercased and sorted; values trimmed. Both are part of what is signed, so a
  // difference of one space produces a signature mismatch and no explanation.
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const signedHeaders = names.join(';')
  const canonicalHeaders = names
    .map((name) => {
      const [, value] = Object.entries(headers).find(([key]) => key.toLowerCase() === name) ?? []
      return `${name}:${String(value).trim().replace(/\s+/g, ' ')}\n`
    })
    .join('')

  const payloadHash = sha256Hex(options.body)

  const canonicalRequest = [
    options.method.toUpperCase(),
    encodePath(options.url.pathname || '/'),
    canonicalQuery(options.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const dateKey = hmac(`AWS4${options.secretAccessKey}`, dateStamp)
  const regionKey = hmac(dateKey, options.region)
  const serviceKey = hmac(regionKey, options.service)
  const signingKey = hmac(serviceKey, 'aws4_request')
  const signature = Buffer.from(hmac(signingKey, stringToSign)).toString('hex')

  return {
    ...headers,
    'x-amz-content-sha256': payloadHash,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
