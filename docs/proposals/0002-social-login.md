# Proposal 0002 — Google and GitHub sign-in

Status: **draft, awaiting decisions D33–D35**
Context: the most requested thing the framework does not do, and the last obvious gap in auth.

Verified against the code at `50ce9ed`. Where a claim was checked, it says how.

---

## Summary

Add Google and GitHub sign-in to the auth bricks that already exist, as **two independently
optional flows** beside the password flow. One user, several credentials.

**No second brick, no breaking migration, no change to any route you have written.** An app that
never configures `oauth` upgrades and behaves identically.

| | |
| --- | --- |
| Size | M — mostly one shared package |
| Risk | the decisions, not the code |
| Blocking | D33 (linking), D34 (verified email), D35 (provider tokens) |

---

## What is true today

- **`auth-basic` is 35 lines.** It calls `passwordAuthProvider` and passes a Drizzle store. Every
  flow, endpoint, cookie and rate limit lives in `@theoven/auth` (D26), which is where nearly all
  of this work lands. `auth-mongo` is the same shape over Mongoose.
- **There is no concept of a linked account** anywhere in `AuthStore` — ten methods across users,
  refresh tokens and reset tokens, and nothing else.
- **`auth_users` requires a password.** `password_hash` is `NOT NULL`, and `StoredUser.passwordHash`
  is a required `string`. A user who has never had a password is unrepresentable.
- **`email` and `name` are also `NOT NULL`.** GitHub will withhold an email unless asked for it,
  and can have none verified at all.
- **Signed cookies are in core**, `httpOnly` and `SameSite=Lax` by default. Enough to carry OAuth
  state without a table.
- **`AuthStore` is a public contract.** The docs invite third-party storage bricks and give them a
  conformance suite to run, so adding *required* methods to it would break them.

---

## The shape

### Three flows, one identity

| Flow | Turned on by | Endpoints |
| --- | --- | --- |
| Email + password | on by default | `signup`, `login`, `forgot-password`, `reset-password`, `change-password` |
| Google | `oauth: { google }` | `/auth/oauth/google`, `/auth/oauth/google/callback` |
| GitHub | `oauth: { github }` | the same two |
| — | any flow on | `refresh`, `logout`, `me` |

Any combination. Password-only is exactly today. OAuth-only mounts **no `/auth/signup`** — leaving
it up on an app that meant to be invite-only-through-GitHub is not clutter, it is a hole.

The endpoints split into **session**, **password** and **oauth** groups. That decomposition is the
substance of the change; everything else follows from it.

### `identify()` does not change

OAuth *establishes* a session. Once established it is the same short access JWT and the same
revocable refresh row (D20). So `auth: true`, named policies, `logout`, sign-out-everywhere and
password-change-invalidates-sessions keep working untouched, and an OAuth session is revocable for
free.

This is the property that makes the whole thing cheap.

### No breaking migration

An OAuth-created user gets an **unusable password** rather than a null one — Django's
`set_unusable_password()`, which is fifteen years old and boring in the right way. The sentinel is
a value no argon2id verification can match, and `verifyPassword('anything', 'not-a-hash')` already
returns `false`, with a test.

So `password_hash` stays `NOT NULL` and `auth_users` is untouched. The only new schema is the
accounts table.

> An earlier version of this thinking said the column had to become nullable and that a breaking
> migration was unavoidable. It is not, and the sentinel is why. Recorded because the wrong version
> nearly justified a second brick.

### The accounts table is opt-in

`auth-basic` exports `./schema` today. The accounts table goes on a **second export path**, so an
app that wants OAuth adds one line to its own `schema.ts`:

- migrations stay deterministic and follow from what you exported
- nobody gets a table they did not ask for
- the line is in **your** file, so nothing appears in `git status` you did not write

### The store methods are optional

Three methods — find an account, link one, unlink one — added to `AuthStore` as **optional**.
Configuring `oauth` against a store that does not implement them fails **at boot**, naming the
store, rather than at the first callback.

That is D19 exactly: a declared capability checked at startup, the same reason `auth-clerk` can say
it cannot sign anyone out. It also means third-party stores written against today's contract keep
working untouched.

### The provider interface

A provider is data plus one function: authorization URL, token URL, scopes, and a mapper from a
token response to an `Identity`. Google is OIDC with a userinfo endpoint; GitHub is plain OAuth2
and needs a second call to `/user/emails` when the primary address is private.

**Apple is deliberately not in this proposal.** Its client secret is a JWT you sign yourself with
an ES256 key, its callback is a form POST, and it returns a name and email *only on first
authorisation*. Designing for Apple now would over-build the interface; designing for Google and
then bolting Apple on would force a rewrite. Two providers now, Apple as the deliberate second pass
that stresses the interface, is the version that ages well.

---

## Security requirements

Not optional, and each is somewhere this goes wrong quietly.

| | |
| --- | --- |
| `state`, signed and single-use | CSRF on the callback. A signed cookie, no table |
| PKCE (S256) | even for confidential clients |
| `nonce`, checked on Google's id_token | replay |
| Exact `redirect_uri` match | not a prefix |
| Provider account already linked elsewhere | refuse, do not steal it |
| Unlinking the last credential | refuse — it is self-lockout |
| `change-password` on an unusable password | `409` naming the reason, not a crash |

---

## Decisions

### D33 — account linking

Someone signs up with a password as `ada@example.com`, then later signs in with Google as
`ada@example.com`. Same user, or a new one?

- **(a) Never auto-link.** The provider sign-in fails and tells them to sign in and link from
  settings. Safest, most friction, and the friction lands on a confused user who did nothing wrong.
- **(b) Auto-link when the provider asserts the email is verified.** Convenient and safe *given a
  provider that actually verifies* — Google's `email_verified` and GitHub's `verified` flag both
  do.
- **(c) Auto-link on a matching email, always.** A known account-takeover path the moment a
  provider that does not verify is added.

**Recommendation: (b)**, configurable, with the verification requirement as the thing that keeps it
safe when a third provider arrives. (c) is not offered even as an option.

### D34 — is a provider-verified email required?

GitHub can return no usable email. Since email is the anchor for linking and for recovery, an
account without one can never be linked or recovered.

- **(a) Require one.** Sign-in fails with a readable message when the provider gives none.
- **(b) Allow email-less users**, keyed only on `(provider, accountId)`.

**Recommendation: (a).** (b) quietly creates users who are permanently unrecoverable and
unlinkable, and it is a one-way door — you cannot retrofit an email onto an account nobody can sign
in to. Refusing at the door is the kinder failure. It also keeps `email NOT NULL` true.

### D35 — do we store provider access and refresh tokens?

Storing them lets an app call the provider's API later. It also means a breach hands over live
credentials to someone else's service.

- **(a) Do not store by default**, opt in per provider when the app actually needs them.
- **(b) Always store**, as most libraries do.

**Recommendation: (a).** Most apps want sign-in, not the GitHub API. Tokens nobody reads are pure
liability, and this is the sort of default that is judged after the incident, not before.

---

## Work

1. `AuthStore` — three optional account methods, plus conformance tests, including that linking an
   account already attached to another user is refused
2. Unusable-password sentinel, and `change-password` returning `409` when it meets one
3. Split endpoint registration into session / password / oauth groups so flows are independently
   optional
4. OAuth flows in `@theoven/auth`: authorize with state + PKCE + nonce, callback, exchange,
   find-or-create-and-link, issue the existing token pair
5. Google and GitHub provider definitions, including GitHub's private-email call
6. Accounts storage in `auth-basic` (Drizzle) and `auth-mongo` (Mongoose), plus the second schema
   export path
7. Docs: a brick page section, the catalogue table, and the linking rule stated where someone
   configuring it will read it

Tests worth naming up front, because they are the ones that fail quietly otherwise: a mismatched
`state` is refused; a replayed `state` is refused; a provider account already linked to another
user is refused; auto-linking does **not** happen on an unverified email; unlinking the last
credential is refused.

---

## Explicitly not in this proposal

- **Apple** — see above.
- **OAuth2 scopes as an authorization model.** Separate gap, already on the FastAPI list. Doing
  sign-in first and scopes later means touching this code twice, and that is accepted deliberately
  rather than by omission.
- **Being an OAuth2 *provider*.** This is sign-in with someone else's identity, not issuing
  identities to third-party apps.
- **A strategy ecosystem.** Passport has five hundred strategies because it owns neither storage nor
  sessions. Oven owns both, so a third-party provider supplies a definition, not a strategy —
  narrower, and far less for the author to get wrong.
- **Changing `auth-clerk` or `auth-better`.** Both already do OAuth their own way. The overlap is
  real and accepted: you should not need a third-party dependency for the most requested feature,
  which is the same argument that justifies `auth-basic`.

---

## What could go wrong

- **The linking rule is the whole risk.** Everything else is protocol work with well-known answers.
- **`email NOT NULL` holds only while D34 is (a).** Choosing (b) later is a breaking migration, so
  the decision is more load-bearing than it looks.
- **Two storage bricks must stay in step.** That is what the conformance suite is for, and the
  account methods have to be in it from the first commit, not added afterwards.

---

## Decisions to lock

| | |
| --- | --- |
| **D33** | Account linking: auto-link only on a provider-verified email. |
| **D34** | A provider-verified email is required; sign-in fails without one. |
| **D35** | Provider tokens are not stored unless the app opts in. |
