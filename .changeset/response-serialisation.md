---
'@theoven/core': minor
---

Response schemas now **filter the response body** (D29).

A declared `response` schema's parsed output becomes what is sent, in every environment. Zod
strips keys it does not declare, so a handler returning a database row sends only the fields it
promised — a `passwordHash` on that row cannot reach the client.

Previously the parsed value was computed and discarded, and validation was off in production, so
declaring a response schema did nothing there at all.

- `serializeResponses` (new, default `true`) turns filtering off.
- `validateResponses` now governs only the failure case: a value that does not parse is a `500`
  in development, and in production is logged with `filtered: false` while the request succeeds.
  Failing closed in production would turn a drifted schema into an outage on deploy.
- Costs ~480ns on routes that declare a response schema, and nothing on routes that do not.

**Breaking if you relied on undeclared fields being sent.** Add them to the schema, or set
`serializeResponses: false`.

Also fixes: a handler returning a `Response`, `ReadableStream`, `Blob`, `Bun.file`, typed array
or `URL` returned a `500` when its route declared a response schema. These now bypass both
validation and serialisation.
