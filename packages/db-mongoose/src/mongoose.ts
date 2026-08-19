import type { DatabaseProvider } from '@theoven/db'
import { type Connection, type ConnectOptions, createConnection } from 'mongoose'

export interface MongooseOptions {
  /**
   * The connection string, e.g. `mongodb://localhost:27017/myapp`.
   *
   * Read it from the environment: `env.string('MONGO_URL')`.
   */
  url: string
  /**
   * Passed through to Mongoose unchanged.
   *
   * Everything Mongoose can be told about pooling, timeouts and TLS belongs here rather than in
   * options we would restate and then fall behind on.
   */
  connection?: ConnectOptions
}

/**
 * MongoDB through Mongoose.
 *
 * `ctx.db` is a Mongoose **`Connection`**, not the global `mongoose` singleton. Models come off
 * it — `ctx.db.model('User', userSchema)` — which means two Oven apps in one process, or an app
 * and its test suite, do not fight over global state. It also means shutdown genuinely closes
 * *this* app's connection.
 *
 * ```ts
 * const app = createApp().use(db({ provider: mongooseDb({ url: env.string('MONGO_URL') }) }))
 *
 * app.get('/users', async (ctx) => ctx.db.model('User', userSchema).find())
 * ```
 */
export function mongooseDb(options: MongooseOptions): DatabaseProvider<Connection> {
  if (!options.url) {
    throw new Error(
      'mongooseDb needs a connection url. Read one from the environment: ' +
        "mongooseDb({ url: env.string('MONGO_URL') })",
    )
  }

  return {
    name: 'mongoose:mongodb',

    // `asPromise()` waits for the connection to be usable. Without it `connect()` returns a
    // Connection that is still dialling, and the first request races it.
    connect: () => createConnection(options.url, options.connection).asPromise(),

    /**
     * A real round trip to the server.
     *
     * `readyState` would be cheaper and would report `1` for a connection whose server has since
     * gone away — a health check that cannot fail.
     */
    health: async (connection) => {
      const admin = connection.db?.admin()
      if (!admin) return false
      const result = await admin.command({ ping: 1 })
      return result.ok === 1
    },

    close: (connection) => connection.close(),

    /**
     * Deliberately absent — see the note below. `transaction(ctx.db, ...)` refuses for this
     * provider rather than running the work unwrapped.
     */
  }
}

/**
 * ## Why there is no `transaction` here
 *
 * This is the adapter that tested the contract, and this is where it pushed back.
 *
 * Every SQL provider scopes a transaction to a *client*: Drizzle hands `work` a `tx` object, and
 * every query through it is inside the transaction. Mongoose scopes a transaction to a
 * **session**, which has to be attached to each individual query — `Model.find().session(s)`.
 * There is no session-scoped `Connection` to hand `work`.
 *
 * We could fake one: proxy the `Connection`, proxy every model it returns, and attach the session
 * to each query as it is built. It would work for `find` and `save` and quietly not work for
 * `aggregate`, `bulkWrite`, `watch`, and anything a user reaches for that we did not anticipate —
 * a transaction that silently covers some of your writes is worse than none.
 *
 * So the provider declares the truth: no portable transaction. `transaction(ctx.db, work)` throws
 * a named error instead of running unwrapped, and Mongo users use Mongoose's own form, which is
 * the documented escape hatch for exactly this:
 *
 * ```ts
 * await ctx.db.transaction(async (session) => {
 *   await Order.create([order], { session })
 *   await Inventory.updateOne(query, update, { session })
 * })
 * ```
 *
 * (That form needs a replica set or a sharded cluster. A standalone `mongod` has no transactions
 * at all, which is its own reason not to pretend otherwise at the contract level.)
 */
