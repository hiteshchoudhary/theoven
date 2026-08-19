# create-theoven

[![npm](https://img.shields.io/npm/v/create-theoven)](https://www.npmjs.com/package/create-theoven)

> Scaffold an [Oven](https://theoven.app) app.

```bash
bun create theoven my-app
```

```bash
bun create theoven my-app --db sqlite --auth basic --yes
```

| Flag | Values |
| --- | --- |
| `--template` | `minimal`, `api` |
| `--db` | `sqlite`, `postgres`, `none` |
| `--auth` | `basic`, `none` |
| `--no-openapi` | skip the OpenAPI brick and `/docs` |
| `--yes` | accept every default |

`--db sqlite` scaffolds Drizzle over `bun:sqlite` — no server to run. `--auth basic` adds working
signup, login and password reset, with mail defaulting to the console driver so the reset link
appears in your terminal.

Every project also gets an `AGENTS.md` describing the conventions, so a coding agent does not
reach for Express habits.

This is a thin wrapper around [`oven create`](https://theoven.app/docs/reference/cli/) from
`@theoven/cli` — same scaffolder, one implementation.

## Documentation

**[https://theoven.app/docs](https://theoven.app/docs)**

## License

MIT
