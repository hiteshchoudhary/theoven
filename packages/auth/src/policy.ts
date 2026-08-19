import type { Context } from '@theoven/core'
import type { Identity } from './identity'

/**
 * A named authorization rule.
 *
 * Roles are deliberately not part of `Identity` (D17), so a portable `role: 'admin'` guard
 * would fail on every provider that has no roles. A policy is a plain function instead: it
 * works on any provider, it is unit-testable on its own, it is greppable, and it can be named
 * in the generated OpenAPI document.
 *
 * ```ts
 * export const policies = {
 *   admin: (user) => user.raw.publicMetadata?.role === 'admin',
 *   owner: (user, ctx) => user.id === ctx.params.userId,
 * }
 * ```
 */
export type Policy<Raw = unknown> = (
  user: Identity<Raw>,
  ctx: Context,
) => boolean | Promise<boolean>

export type Policies<Raw = unknown> = Record<string, Policy<Raw>>

/**
 * What a route may declare as its `auth` requirement.
 *
 * - `true` — must be signed in
 * - `false` — explicitly public, which is worth being able to say out loud
 * - a policy name, or several (all must pass)
 */
export type AuthRequirement = boolean | string | readonly string[]

/** Reads a route's `auth` key, which core carries but never interprets. */
export function requirementOf(schema: { auth?: unknown } | undefined): AuthRequirement | undefined {
  const value = schema?.auth
  if (value === undefined) return undefined
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as readonly string[]
  }
  return undefined
}

/** The policy names a requirement refers to. Empty for `true`/`false`. */
export function policyNames(requirement: AuthRequirement): readonly string[] {
  if (typeof requirement === 'boolean') return []
  return typeof requirement === 'string' ? [requirement] : requirement
}
