---
'@theoven/webhooks': minor
'@theoven/ratelimit': minor
'@theoven/vector': minor
'@theoven/vector-pg': minor
'@theoven/vector-qdrant': minor
---

Three new bricks: verified inbound webhooks, shared rate limiting, and vector search.

- **`webhooks`** — signature verification for inbound deliveries, constant-time, with replay
  windows.
- **`ratelimit`** — counting that holds across instances, atomically, on Redis or Postgres.
- **`vector`** — one contract over an embedded scan, pgvector and Qdrant, all three passing the
  same conformance suite and agreeing on cosine similarity to three decimals.
