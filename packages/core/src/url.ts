/**
 * The request path, without building a `URL`.
 *
 * Routing needs the pathname on every request, and `new URL()` costs roughly 580 ns to answer a
 * question a substring already answers. This scan is the hot path; `ctx.url` stays available and
 * lazy for anything that genuinely needs a parsed URL.
 *
 * **This is safe because `Request` has already canonicalised the URL.** By the time `request.url`
 * reaches us, dot segments are resolved, `%2e%2e` is decoded and collapsed, and backslashes are
 * converted — so a scan and a parse return the same string. That equivalence is not an assumption:
 * `url.test.ts` asserts it across traversal, encoded traversal, null bytes, protocol-relative and
 * unicode paths, and fails if the two ever diverge.
 *
 * Do not use this on a URL string that did not come from a `Request`.
 */
export function pathnameOf(url: string): string {
  const start = url.indexOf('/', url.indexOf('//') + 2)
  if (start === -1) return '/'

  let end = url.length
  const query = url.indexOf('?', start)
  if (query !== -1) end = query
  const hash = url.indexOf('#', start)
  if (hash !== -1 && hash < end) end = hash

  return start === end ? '/' : url.slice(start, end)
}
