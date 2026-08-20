# @theoven/ai

## 0.6.1

### Patch Changes

- Updated dependencies
  - @theoven/core@0.6.1

## 0.6.0

### Minor Changes

- 72ea0e1: The AI brick: everything around an AI SDK call, and none of the call itself.
  
  ```ts
  app.use(ai({ model: openai('gpt-4o-mini') }))
  
  export default (ctx) => ctx.ai.stream({ prompt: ctx.body.prompt })
  ```
  
  Providers, prompts, tools and structured output stay the AI SDK's job. What this adds is the
  infrastructure people rediscover in production: SSE streaming, cancelling the provider call
  when the client hangs up, caching (including collapsing identical concurrent calls into one),
  token accounting with optional pricing, and a per-request token budget.
  
  Token counts stay `undefined` when a provider does not report them, and cost stays `undefined`
  without pricing — never `0`, because nobody investigates a zero.

### Patch Changes

- Updated dependencies [dee857d]
- Updated dependencies [50ce9ed]
- Updated dependencies [c69c632]
- Updated dependencies [313025d]
- Updated dependencies [313025d]
- Updated dependencies [ef8bb69]
- Updated dependencies [8589b1e]
- Updated dependencies [e59fb64]
- Updated dependencies [1ae044a]
  - @theoven/core@0.6.0
