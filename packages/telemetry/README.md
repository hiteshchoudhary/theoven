# @theoven/telemetry

[![npm](https://img.shields.io/npm/v/@theoven/telemetry)](https://www.npmjs.com/package/@theoven/telemetry)

> OpenTelemetry tracing for Oven — spans, context propagation and log correlation.

```bash
bun add @theoven/telemetry @opentelemetry/api
```

```ts
import { telemetry } from '@theoven/telemetry'

app.use(telemetry())
```

Brings no SDK and no exporter — you configure those as you would for any OpenTelemetry
application, and this uses whatever is globally registered.

Spans are named by **route pattern** (`GET /users/:id`), not path, so a backend can aggregate.
Only 5xx marks a span as failed: a 404 is the server working correctly, and an error rate made of
other people's typos is a dashboard nobody looks at.

## Documentation

**[https://theoven.app/docs/bricks/telemetry/](https://theoven.app/docs/bricks/telemetry/)**

## License

MIT
