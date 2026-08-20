import { describeVectorStore } from '@theoven/vector/testing'
import { pgVector } from './pgvector'

/**
 * Against a **real Postgres with pgvector**, when one is reachable.
 *
 * The third structurally different implementation: server-side SQL with an index, where SQLite
 * scans in process and Qdrant is a hosted HTTP service. One suite over all three is what makes
 * `VectorStore` a contract rather than a description of the first one written.
 */
const URL = Bun.env.PGVECTOR_TEST_URL

if (URL) {
  describeVectorStore('pgvector', () => pgVector({ url: URL, dimensions: 4 }))
} else {
  console.log('[vector-pg] PGVECTOR_TEST_URL not set — pgvector tests skipped.')
}
