/**
 * The database contract.
 *
 * Deliberately small. It covers what every application needs and every ORM does differently —
 * connecting, checking health, closing cleanly, running a transaction — and stops there.
 *
 * **Queries are not part of it.** `ctx.db` is the native client: the Drizzle instance, the
 * `PrismaClient`, the Mongoose connection, typed from your own schema. A unified query API would
 * be permanently behind every ORM and worse than all of them, and it would throw away the thing
 * that makes this pleasant to write with a coding agent — a model knows Drizzle and Prisma cold,
 * and would know an invented Oven API not at all. See `CLAUDE.md` D16.
 */
export interface DatabaseProvider<Client = unknown> {
  /**
   * Identifies the provider in logs and errors, e.g. `drizzle:sqlite`.
   *
   * Included because "database connection failed" is a useless message when an app has two
   * of them.
   */
  readonly name: string

  /** Opens the connection and returns the native client. Runs once, at boot. */
  connect(): Client | Promise<Client>

  /**
   * Answers whether the database is reachable *now*.
   *
   * Should issue a real query — `SELECT 1` or equivalent — rather than reporting whether a
   * pool object exists. A health check that cannot fail is not a health check.
   */
  health(client: Client): boolean | Promise<boolean>

  /** Closes the connection during graceful shutdown. */
  close(client: Client): void | Promise<void>

  /**
   * Runs `work` inside a transaction, passing a client scoped to it.
   *
   * Optional, because not every store has transactions worth the name. A provider that omits
   * it fails loudly when a transaction is requested, rather than silently running the work
   * without one — which is the failure mode that quietly corrupts data.
   */
  transaction?<Result>(client: Client, work: (tx: Client) => Promise<Result>): Promise<Result>
}

/**
 * Maps a client back to the provider that made it.
 *
 * A `WeakMap` rather than a property on the client: the client belongs to the ORM, and bolting
 * framework state onto someone else's object is how you collide with a future release of
 * theirs. This also keeps `ctx.db` exactly what the ORM handed us, with nothing added.
 */
const providers = new WeakMap<object, DatabaseProvider<never>>()

/** Records which provider produced a client. Called by the brick at boot. */
export function rememberProvider<Client>(client: Client, provider: DatabaseProvider<Client>): void {
  if (typeof client === 'object' && client !== null) {
    providers.set(client, provider as DatabaseProvider<never>)
  }
}

/**
 * The provider behind a client, if it came from an Oven brick.
 *
 * This is how a brick that depends on the database — an auth brick, a queue brick — reaches
 * lifecycle operations without every one of them having to accept a provider separately.
 */
export function providerFor<Client>(client: Client): DatabaseProvider<Client> | undefined {
  if (typeof client !== 'object' || client === null) return undefined
  return providers.get(client) as DatabaseProvider<Client> | undefined
}

/** Raised when a database operation cannot be performed. Names the provider. */
export class DatabaseError extends Error {
  override name = 'DatabaseError'
  readonly provider: string | undefined

  constructor(message: string, options: { provider?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.provider = options.provider
  }
}

/**
 * Runs `work` in a transaction on any client an Oven db brick produced.
 *
 * Portable across providers, which is what a brick storing its own tables needs. Application
 * code can equally call the native form — `ctx.db.transaction(...)` in Drizzle,
 * `ctx.db.$transaction(...)` in Prisma — and should, when it wants that ORM's own options.
 *
 * @throws {DatabaseError} when the client came from outside Oven, or its provider has no
 * transaction support. Both are refused rather than run unwrapped: work that silently escapes
 * its transaction is the failure nobody notices until the data is already wrong.
 */
export async function transaction<Client, Result>(
  client: Client,
  work: (tx: Client) => Promise<Result>,
): Promise<Result> {
  const provider = providerFor(client)

  if (!provider) {
    throw new DatabaseError(
      'This client did not come from an Oven database brick, so its transaction support is ' +
        "unknown. Use the client's own transaction method instead.",
    )
  }

  if (!provider.transaction) {
    throw new DatabaseError(
      `The "${provider.name}" provider does not support transactions. Running this work ` +
        'without one would be worse than failing, so it fails.',
      { provider: provider.name },
    )
  }

  return provider.transaction(client, work)
}

/** Checks a client's health through its provider. Returns `false` if the check itself throws. */
export async function checkHealth<Client>(client: Client): Promise<boolean> {
  const provider = providerFor(client)
  if (!provider) return false

  try {
    return await provider.health(client)
  } catch {
    // An unreachable database throws rather than returning false, and a health endpoint that
    // 500s tells a load balancer far less than one that reports "not healthy".
    return false
  }
}
