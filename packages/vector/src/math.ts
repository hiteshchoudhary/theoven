/**
 * Cosine similarity, and the normalisation that makes it a dot product.
 *
 * Normalising once on write turns every later comparison into a dot product — no square roots in
 * the hot loop, which is most of what makes an in-process scan viable at all.
 */

/** Scales a vector to unit length. Returns a copy; a zero vector is returned unchanged. */
export function normalise(embedding: readonly number[]): Float32Array {
  const out = new Float32Array(embedding.length)
  let sum = 0
  for (let index = 0; index < embedding.length; index++) {
    const value = embedding[index] as number
    out[index] = value
    sum += value * value
  }

  const magnitude = Math.sqrt(sum)
  // A zero vector has no direction, so there is nothing to scale. Dividing would produce NaN and
  // poison every later comparison silently.
  if (magnitude === 0) return out

  for (let index = 0; index < out.length; index++) out[index] = (out[index] as number) / magnitude
  return out
}

/** Dot product of two already-normalised vectors, which is their cosine similarity. */
export function dot(a: Float32Array, b: Float32Array, offset = 0): number {
  let total = 0
  for (let index = 0; index < a.length; index++) {
    total += (a[index] as number) * (b[offset + index] as number)
  }
  return total
}
