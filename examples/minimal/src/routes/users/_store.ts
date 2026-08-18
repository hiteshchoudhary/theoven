/** Shared in-memory data. The leading underscore keeps it out of the route table. */
export const users = new Map<string, { id: string; name: string }>([
  ['1', { id: '1', name: 'Ada Lovelace' }],
  ['2', { id: '2', name: 'Grace Hopper' }],
])
