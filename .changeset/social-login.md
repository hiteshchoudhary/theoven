---
'@theoven/auth': minor
'@theoven/auth-basic': minor
'@theoven/auth-mongo': minor
---

Sign in with Google and GitHub.

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
