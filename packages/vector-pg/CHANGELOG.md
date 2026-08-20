# @theoven/vector-pg

## 0.6.0

### Minor Changes

- 72ea0e1: Three new bricks: verified inbound webhooks, shared rate limiting, and vector search.
  
  - **`webhooks`** — signature verification for inbound deliveries, constant-time, with replay
    windows.
  - **`ratelimit`** — counting that holds across instances, atomically, on Redis or Postgres.
  - **`vector`** — one contract over an embedded scan, pgvector and Qdrant, all three passing the
    same conformance suite and agreeing on cosine similarity to three decimals.

### Patch Changes

- Updated dependencies [dee857d]
- Updated dependencies [50ce9ed]
- Updated dependencies [c69c632]
- Updated dependencies [313025d]
- Updated dependencies [313025d]
- Updated dependencies [72ea0e1]
- Updated dependencies [ef8bb69]
- Updated dependencies [8589b1e]
- Updated dependencies [e59fb64]
- Updated dependencies [1ae044a]
  - @theoven/core@0.6.0
  - @theoven/vector@0.6.0
