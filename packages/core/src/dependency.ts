import type { Context } from './context'

/**
 * Brand, so a dependency is recognisable across module copies.
 *
 * Same reasoning as the router's (D30): `instanceof` breaks when a bundler ends up with two
 * copies of this module, and the failure — a dependency silently unrecognised — would be hard
 * to attribute.
 */
const DEPENDENCY = Symbol.for('oven.dependency')

/** Shared empty ancestry, so the common top-level resolution allocates nothing extra. */
const EMPTY: readonly Dependency<unknown>[] = []

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
  use = <Value>(target: Dependency<Value>): Promise<Value> => this.useWith(target, EMPTY)

  /**
   * Resolves a dependency, once per request, tracking who asked for it.
   *
   * `ancestry` is the chain that led here, and it is **per branch** rather than one shared stack.
   * That matters because independent dependencies resolve concurrently: a single stack would
   * interleave unrelated branches, and a genuine cycle would then be reported with every
   * dependency the request happened to be resolving at the time attached to its path.
   *
   * The cycle check cannot be the cache: a cycle closes inside the resolver's *synchronous*
   * prefix, before `start` has returned the promise the cache stores.
   */
  private useWith<Value>(
    target: Dependency<Value>,
    ancestry: readonly Dependency<unknown>[],
  ): Promise<Value> {
    const existing = this.cache?.get(target as Dependency<unknown>)
    if (existing) return existing as Promise<Value>

    if (ancestry.includes(target as Dependency<unknown>)) {
      const path = [...ancestry, target].map((entry) => entry.name).join(' -> ')
      throw new DependencyCycleError(`Dependency cycle: ${path}.`)
    }

    const work = this.start(target, ancestry)
    this.cache ??= new Map()
    this.cache.set(target as Dependency<unknown>, work)
    return work as Promise<Value>
  }

  private async start<Value>(
    target: Dependency<Value>,
    ancestry: readonly Dependency<unknown>[],
  ): Promise<Value> {
    const resolve = (this.overrides?.get(target as Dependency<unknown>) ?? target.resolve) as
      | ValueResolver<Value>
      | ScopedResolver<Value>

    /**
     * The `use` handed to this resolver knows what led here, so anything it asks for is checked
     * against its own branch and not against whatever else the request is doing.
     *
     * The extended chain is built on first use rather than up front. Most dependencies have no
     * sub-dependencies and never call this, and allocating an array for each of them was
     * measurable — ~180ns on a route with one dependency.
     */
    let extended: readonly Dependency<unknown>[] | undefined
    const branch: Use = (dependency) => {
      extended ??= [...ancestry, target as Dependency<unknown>]
      return this.useWith(dependency, extended)
    }

    const produced = resolve(this.ctx, branch)

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
   * Resolves a route's declared dependencies, concurrently.
   *
   * Independent dependencies are usually I/O — a query, a cache read, a call to something else.
   * Resolving them one after another made a route wait for the sum rather than the slowest, which
   * on three 10ms dependencies was 33ms instead of 11ms.
   *
   * `allSettled` rather than `all`: a rejection from `all` leaves its siblings running with
   * nobody awaiting them, which is both an unhandled rejection and a generator that yielded with
   * no one to tear it down. Settling everything means the scope knows about all of them before
   * anything throws.
   *
   * The failure reported is the **first in declaration order**, not the first to reject, so the
   * error a route produces does not depend on which of its dependencies happened to lose a race.
   */
  async resolveAll(
    declared: Record<string, Dependency<unknown>>,
  ): Promise<Record<string, unknown>> {
    const names = Object.keys(declared)

    // The single-dependency case is the common one and does not need the machinery.
    if (names.length === 1) {
      const only = names[0] as string
      return { [only]: await this.use(declared[only] as Dependency<unknown>) }
    }

    const settled = await Promise.allSettled(
      names.map((name) => this.use(declared[name] as Dependency<unknown>)),
    )

    const resolved: Record<string, unknown> = {}
    let failure: { reason: unknown } | undefined

    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        resolved[names[index] as string] = outcome.value
      } else if (!failure) {
        failure = { reason: outcome.reason }
      }
    }

    if (failure) throw failure.reason
    return resolved
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
