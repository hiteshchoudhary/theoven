# @theoven/cli

[![npm](https://img.shields.io/npm/v/@theoven/cli)](https://www.npmjs.com/package/@theoven/cli)

> Scaffold, run, build and inspect Oven apps.

Part of [**Oven**](https://theoven.app) — the batteries-included framework for Bun. Add a brick,
get a feature, fully typed.

## Install

```bash
bun add @theoven/cli
```

## Usage

```bash
bun add -d @theoven/cli

oven create my-app --db sqlite --auth basic
oven dev                  # watcher
oven db generate|migrate  # schema and migrations
oven worker               # background jobs
oven routes               # the route table
oven openapi > api.json
oven doctor               # what is misconfigured, and what to do about it
```

`oven create` writes an `AGENTS.md` into every project, so a coding agent gets the conventions without being told.

## Documentation

**[https://theoven.app/docs/reference/cli/](https://theoven.app/docs/reference/cli/)**

Reading this with a coding agent? [`llms.txt`](https://theoven.app/llms.txt) is a model-readable
index of the whole documentation set, generated from it at build time.

## License

MIT
