# @theoven/auth-basic

## 0.6.1

### Patch Changes

- Updated dependencies
  - @theoven/core@0.6.1
  - @theoven/auth@0.6.1

## 0.6.0

### Minor Changes

- 466ee2a: Sign in with Google and GitHub.
  
  ```ts
  basicAuth({
    db: client,
    secret: env.string('AUTH_SECRET'),
    callbackUrl: (provider) => `${env.string('APP_URL')}/auth/oauth/${provider}/callback`,
    oauth: {
      google: { provider: google, clientId, clientSecret },
      github: { provider: github, clientId, clientSecret },
    },
  })
  ```
  
  Two optional flows beside the password flow. Each configured provider mounts two endpoints and
  nothing else, and an OAuth sign-in issues the **same** session a password login does — so
  `auth: true`, your policies, logout and sign-out-everywhere all keep working untouched.
  
  `password: false` turns the password endpoints off entirely, for an application that authenticates
  only through providers. The session endpoints stay.
  
  Additive: an app that never configures `oauth` is unaffected. No migration, no new tables, no new
  endpoints. Users created by a provider get an unusable password rather than a null one, so
  `auth_users` is untouched.
  
  - Linking happens only when the provider verified the email address (D33)
  - A provider returning no verified email is refused rather than creating an unrecoverable account (D34)
  - Provider tokens are not stored unless you opt in with `storeTokens` (D35)

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
- Updated dependencies [466ee2a]
  - @theoven/core@0.6.0
  - @theoven/auth@0.6.0
