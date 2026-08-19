#!/usr/bin/env bun
/**
 * `bun create theoven my-app`
 *
 * A delegate, not a second implementation. Everything this does is `oven create`, which already
 * knows how to prompt, validate a project name, refuse a non-empty directory and render a
 * template. Two scaffolders would drift, and the one that drifts is the one people meet first.
 *
 * The name is `create-theoven` rather than `create-oven` because `create-oven` on npm belongs to
 * someone else — see D27.
 */
import { run } from '@theoven/cli'

/**
 * Bun passes the target directory as the first argument, and everything after it verbatim, so
 * `bun create theoven my-app --db postgres` arrives here as `['my-app', '--db', 'postgres']`.
 */
process.exit(await run(['create', ...process.argv.slice(2)]))
