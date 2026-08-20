const sql = new Bun.SQL('postgres://postgres:test@localhost:5499/vectors')
await sql.unsafe('drop table if exists probe')
await sql.unsafe('create table probe (id text, meta jsonb)')
await sql.unsafe('insert into probe values ($1, $2::jsonb)', [
  'a',
  JSON.stringify({ kind: 'axis' }),
])
const [r] = (await sql.unsafe(
  'select jsonb_typeof(meta) as t, meta::text as raw from probe',
)) as any[]
console.log('stored jsonb type:', r.t, '| raw:', r.raw)
