import type { Context } from './context'

/**
 * Brand, so a dependency is recognisable across module copies.
 *
 * Same reasoning as the router's (D30): `instanceof` breaks when a bundler ends up with two
 * copies of this module, and the failure — a dependency silently unrecognised — would be hard
 * to attribute.
 */
const DEPENDENCY = Symbol.for('oven.dependency')

/** Resolves other dependencies from inside a resolver. Results are shared within a request. */
export type Use = <Value>(dependency: Dependency<Value>) => Promise<Value>

/** A resolver that returns a value. */
export type ValueResolver<Value> = (ctx: Context, use: Use) => Value | Promise<Value>

/**
 * A resolver that yields a value and cleans up afterwards.
 *
 * The code after `yield` runs once the request is finished. On success the generator is resumed
 * normally; on failure the request's error is **thrown into** it at the `yield`, so a `try`/
 * `catch` around the yield is how a transaction rolls back.
 */
export type ScopedResolver<Value> = (ctx: Context, use: Use) => AsyncGenerator<Value, void, unknown>

export interface Dependency<Value> {
  readonly [DEPENDENCY]: true
  /** Names it in errors and in `oven routes`. */
  readonly name: string
  readonly resolve: ValueResolver<Value> | ScopedResolver<Value>
  readonly scoped: boolean
}

/** Whether a value is a dependency. */
export function isDependency(value: unknown): value is Dependency<unknown> {
  return typeof value === 'object' && value !== null && DEPENDENCY in value
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, void, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncGenerator).next === 'function' &&
    typeof (value as AsyncGenerator).throw === 'function'
  )
}

/**
 * Declares something a route needs, resolved per request.
 *
 * Bricks are app-level: one instance, built at boot, on every request. A dependency is the other
 * scale — per request, and only on the routes that ask for it (D31).
 *
 * ```ts
 * const tenant = dependency('tenant', (ctx) => resolveTenant(ctx.header('host')))
 *
 * const member = dependency('member', async (ctx, use) => {
 *   const current = await use(tenant)          // shared within this request
 *   const found = await findMember(current.id, ctx.user.id)
 *   if (!found) throw new Forbidden('Not a member of this tenant.')
 *   return found
 * })
 *
 * export default route({ auth: true, deps: { member } }, (ctx) => ctx.deps.member.role)
 * ```
 *
 * With an async generator it also cleans up, which is what makes a per-request transaction
 * expressible:
 *
 * ```ts
 * const tx = dependency('tx', async function* (ctx) {
 *   const handle = await begin(ctx.db)
 *   try {
 *     yield handle
 *     await handle.commit()      // the request succeeded
 *   } catch (error) {
 *     await handle.rollback()    // it did not
 *     throw error
 *   }
 * })
 * ```
 */
export function dependency<Value>(name: string, resolve: ScopedResolver<Value>): Dependency<Value>
export function dependency<Value>(name: string, resolve: ValueResolver<Value>): Dependency<Value>
export function dependency<Value>(
  name: string,
  resolve: ValueResolver<Value> | ScopedResolver<Value>,
): Dependency<Value> {
  if (typeof resolve !== 'function') {
    throw new Error(`dependency("${name}") needs a resolver function.`)
  }
  return {
    [DEPENDENCY]: true,
    name,
    resolve,
    // `async function*` is tagged on its constructor, so a scoped resolver is recognised before
    // it runs rather than by inspecting whatever it returned.
    scoped: resolve.constructor?.name === 'AsyncGeneratorFunction',
  }
}

/**
 * A dependency that, directly or through others, depends on itself.
 *
 * Its own class so an application can tell a configuration mistake from a resolver that threw.
 */
export class DependencyCycleError extends Error {
  override name = 'DependencyCycleError'
}

/** Replaces a dependency for the lifetime of an app. Used by tests. */
export type Overrides = Map<Dependency<unknown>, ValueResolver<unknown> | ScopedResolver<unknown>>

/**
 * One request's dependency resolution.
 *
 * Holds the cache and the teardown stack. A scope is created only for routes that declare
 * dependencies, so an app that uses none allocates nothing.
 */
export class DependencyScope {
  /**
   * Both are created on first use rather than in the constructor.
   *
   * The common shape is one dependency, no sub-dependencies and no teardown — which never reads
   * the cache back and never opens a generator. Allocating a Map and an array for that route is
   * pure cost on the hot path.
   */
  private cache: Map<Dependency<unknown>, Promise<unknown>> | undefined
  /** Live generators, in resolution order. Torn down in reverse. */
  private open:
    | Array<{ name: string; generator: AsyncGenerator<unknown, void, unknown> }>
    | undefined
  private disposed = false
  /**
   * Dependencies currently resolving, innermost last.
   *
   * A cycle is caught by membership here rather than by the cache, because the cache entry is
   * only written once `start` has returned — and a cycle closes *inside* the resolver's
   * synchronous prefix, before that happens. Without it, `a → b → a` recursed to a stack
   * overflow and reported "Maximum call stack size exceeded", which names neither dependency.
   */
  private chain: Array<Dependency<unknown>> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly overrides?: Overrides,
  ) {}

  /**
   * Resolves a dependency, once per request.
   *
   * The **promise** is cached rather than the value, so two concurrent `use()` calls for the
   * same dependency share one resolution instead of racing to start two.
   */
  use = <Value>(target: Dependency<Value>): Promise<Value> => {
    const existing = this.cache?.get(target as Dependency<unknown>)
    if (existing) return existing as Promise<Value>

    if (this.chain?.includes(target as Dependency<unknown>)) {
      const path = [...this.chain, target].map((entry) => entry.name).join(' -> ')
      throw new DependencyCycleError(`Dependency cycle: ${path}.`)
    }

    const work = this.start(target)
    this.cache ??= new Map()
    this.cache.set(target as Dependency<unknown>, work)
    return work as Promise<Value>
  }

  private async start<Value>(target: Dependency<Value>): Promise<Value> {
    const resolve = this.overrides?.get(target as Dependency<unknown>) ?? target.resolve

    this.chain ??= []
    this.chain.push(target as Dependency<unknown>)
    try {
      return await this.run(target, resolve as ValueResolver<Value> | ScopedResolver<Value>)
    } finally {
      // Popped when this dependency has fully resolved, not when the resolver returns: a cycle
      // that closes after an `await` is still a cycle.
      const at = this.chain.lastIndexOf(target as Dependency<unknown>)
      if (at !== -1) this.chain.splice(at, 1)
    }
  }

  private async run<Value>(
    target: Dependency<Value>,
    resolve: ValueResolver<Value> | ScopedResolver<Value>,
  ): Promise<Value> {
    const produced = resolve(this.ctx, this.use)

    if (!isAsyncGenerator(produced)) return await produced

    const generator = produced as AsyncGenerator<Value, void, unknown>
    const first = await generator.next()

    if (first.done) {
      throw new Error(
        `dependency("${target.name}") finished without yielding a value. A generator ` +
          'dependency must yield exactly once.',
      )
    }

    // Registered only after it has yielded: a resolver that threw before yielding has nothing
    // to tear down, and calling into it again would run its cleanup against state it never built.
    this.open ??= []
    this.open.push({ name: target.name, generator })
    return first.value
  }

  /**
   * Runs every teardown, in reverse order.
   *
   * @param failure the error that ended the request, or `undefined` if it succeeded. It is
   * thrown into each generator at its `yield`, which is what lets a transaction tell a commit
   * from a rollback.
   */
  async dispose(failure?: unknown): Promise<void> {
    if (this.disposed || !this.open) return
    this.disposed = true

    for (let index = this.open.length - 1; index >= 0; index--) {
      const entry = this.open[index]
      if (!entry) continue

      try {
        const settled =
          failure === undefined
            ? await entry.generator.next()
            : await entry.generator.throw(failure)

        if (!settled.done) {
          this.ctx.log.error('Dependency yielded more than once', { dependency: entry.name })
          await entry.generator.return(undefined)
        }
      } catch (thrown) {
        // A generator that rethrows the failure it was given is the normal shape — the
        // `catch { rollback(); throw }` idiom — and must not be reported as a second problem.
        if (thrown === failure) continue

        /**
         * A teardown that fails on a *successful* request is a real failure of that request: a
         * commit that did not commit means the response about to go out is a lie. It is rethrown
         * so the request becomes a 500.
         *
         * On an already-failing request it is logged instead, because replacing the original
         * error with a cleanup error loses the thing worth reading.
         */
        if (failure === undefined) throw thrown
        this.ctx.log.error('Dependency teardown failed', {
          dependency: entry.name,
          cause: thrown instanceof Error ? thrown.message : String(thrown),
        })
      }
    }
  }
}
