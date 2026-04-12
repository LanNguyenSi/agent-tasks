# Enterprise SSO (OIDC)

agent-tasks supports team-scoped Enterprise Single Sign-On via **OpenID Connect**
as an alternative to email/password or GitHub login. Each team can connect its
own identity provider (Okta, Azure AD, Google Workspace, Auth0, Keycloak, and
others). Users whose email domain matches the team's SSO connection are offered
a one-click login on the auth page and auto-provisioned into the team on first
login.

SSO is additive — existing email/password and GitHub login paths continue to
work, and a user can log in to the same underlying account via any configured
method.

## How it works

```
┌──────────┐   1. enter work email   ┌────────────┐
│ end user │ ─────────────────────▶ │ /auth page │
└──────────┘                         └─────┬──────┘
      ▲                                    │ 2. domain → IdP lookup
      │                                    ▼
      │                            ┌────────────────┐
      │        3. redirect         │  /auth/sso/:s  │
      │  ◀──────────────────────── │   (OIDC start) │
      │                            └────────────────┘
      │
      ▼
┌─────────────┐  4. OIDC authorize code flow (PKCE, nonce)
│ company IdP │ ──────────────────────────────────────────┐
└─────────────┘                                           │
                                                          ▼
                                              ┌──────────────────────┐
                                              │ /auth/sso/:s/callback│
                                              │ verify id_token      │
                                              │ upsert user+identity │
                                              │ auto-join team       │
                                              │ set session cookie   │
                                              └──────────────────────┘
```

The OIDC client is dependency-free and uses WebCrypto for JWKS verification
(RS256 and ES256). PKCE (S256) is mandatory. ID tokens are validated against
the configured issuer, audience, expiry, and the nonce cookie set at
authorize-time.

## Security model

SSO configuration is **deliberately not protected by the normal team ADMIN
role or session cookies**. The motivation: the team ADMIN role is often
granted liberally for project-management needs, and a stolen browser session
should not be enough to repoint a team's IdP (which would let an attacker
redirect all logins to a provider they control).

Instead, SSO admin endpoints require an **AgentToken with the `sso:admin`
scope**:

- Tokens are team-scoped — a token for team A cannot configure team B, even
  with the scope present. The backend enforces `token.teamId === urlTeamId`.
- Tokens carry their own revocation and rotation through the existing
  `/settings → API Tokens` UI.
- The session-based `authMiddleware` explicitly does **not** run for
  `/api/teams/:teamId/sso`, so only the scope-aware guard applies.

A typical rollout:

1. Team admin generates an AgentToken with scope `sso:admin` under
   Settings → API Tokens.
2. Token is handed **out-of-band** (password manager, secure channel) to
   whoever owns IdP configuration — this is usually not the same person.
3. That person opens `/settings/sso`, pastes the token, configures the IdP,
   verifies login.
4. Token is revoked once setup is done. A new token can be minted when the
   config next needs to change.

### What stops account takeover

Two checks protect against the most common IdP-linked-account attacks:

1. **Email-verified requirement for linking.** `upsertUserFromOidc` will only
   link an SSO login to an existing local/GitHub user when the IdP asserts
   `email_verified=true` **and** the email's domain is one the SSO connection
   has explicitly claimed. A malicious IdP that allows users to self-set an
   email cannot hijack an existing `alice@acme.com` account unless the
   connection actually owns `acme.com`.
2. **Domain uniqueness across teams.** A domain can only be claimed by one
   SSO connection. Public free-mail domains (`gmail.com`, `outlook.com`, and
   a few others) are blocked outright. This prevents one team from silently
   auto-joining users from another team.

### What's *not* enforced

- **SSO enforcement.** SSO is additive, not mandatory. A user who knows
  their password (or GitHub login) can still sign in without SSO, even if
  their team has SSO configured. If you want SSO to be the only permitted
  method, that's a separate enforcement feature that doesn't ship today.
- **Project-level ACLs.** Team membership is all-or-nothing: every member
  sees every project and task in the team. SSO doesn't change this — users
  auto-provisioned via SSO land as `HUMAN_MEMBER` with full team visibility.
  If that's too permissive, set `autoProvision=false` on the connection and
  admit users manually.

## Configuration

### Backend environment

| Variable             | Required          | Description |
| -------------------- | ----------------- | ----------- |
| `SSO_ENCRYPTION_KEY` | For any SSO usage | 32 bytes, hex (64 chars) or base64. AES-256-GCM key used to encrypt OIDC client secrets at rest. The backend refuses to accept new connections until this is set. |
| `BACKEND_URL`        | For any SSO usage | Public URL of the backend, used to build the OIDC redirect URI. Must match what you register in the IdP. |

Generate a key:

```sh
openssl rand -hex 32
```

### Prisma

Two new tables ship with this feature:

- `sso_connections` — one row per team, stores issuer, client ID, encrypted
  client secret, claimed email domains, auto-provision flag.
- `user_identities` — federated identity rows (`provider`,
  `providerUserId`) that link back to a `User`. This decouples identity
  from the `User.githubId` column and allows multiple providers per user.

Apply with `prisma db push` or a migration on deploy.

### IdP setup

In your IdP (Okta, Azure AD, etc.), create an OIDC app with:

- **Grant type**: Authorization Code with PKCE
- **Redirect URI**: `$BACKEND_URL/api/auth/sso/<team-slug>/callback`
- **Scopes**: `openid`, `email`, `profile`
- **Token endpoint auth**: `client_secret_post`
- **Sign-in initiated by**: user (the frontend always starts the flow)

Copy the client ID and client secret. You'll paste them into the
`/settings/sso` page.

### In agent-tasks

1. **Generate an SSO admin token.** Settings → API Tokens → New token →
   select the `sso:admin` scope. Copy the token.
2. **Open `/settings/sso`**, paste the token, click "Unlock SSO settings".
3. Fill in the form:
   - **Display name** — shown on the login page (e.g. "Acme Okta").
   - **Issuer URL** — the OIDC issuer, without `/.well-known/...`. agent-tasks
     fetches the discovery document and rejects the save if it doesn't
     respond.
   - **Client ID** / **Client secret** — from the IdP.
   - **Email domains** — comma- or space-separated list of registrable
     domains. Used for login-page discovery and account-linking trust.
   - **Auto-provision new users on first login** — if off, only users who
     already exist in the team can log in via SSO. New SSO logins get a
     `not_provisioned` error.
   - **Enabled** — turn the connection off without deleting it.
4. Click **Update connection**. The backend re-verifies discovery before
   saving.
5. **Test the login.** Log out, go to `/auth`, enter your work email, and
   blur the email field. A "Continue with &lt;IdP&gt;" button should appear.

## API reference

All SSO admin endpoints require `Authorization: Bearer <agent-token>` with
the `sso:admin` scope, **not** a session cookie.

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET`  | `/api/sso/whoami` | Returns the team the token belongs to and the current connection (or `null`). Used by the `/settings/sso` page to resolve the team without an out-of-band team ID. |
| `GET`  | `/api/teams/:teamId/sso` | Current SSO connection for the team. `clientSecretEnc` is never returned. |
| `PUT`  | `/api/teams/:teamId/sso` | Create or update. Fails fast with `400` if OIDC discovery fails, if a claimed domain is already owned by another team, or if the domain is a blocked public-mail provider. |
| `DELETE` | `/api/teams/:teamId/sso` | Remove the connection. Existing sessions for SSO-provisioned users are not invalidated. |

Login-flow endpoints are public:

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/auth/sso/discover?email=...` | Returns the matching team's login URL if an enabled SSO connection claims the email domain, else `null`. |
| `GET` | `/api/auth/sso/:teamSlug` | Start the OIDC authorize flow (redirects to the IdP). |
| `GET` | `/api/auth/sso/:teamSlug/callback` | IdP callback. Validates state, nonce, PKCE verifier, ID token signature, issuer, audience, and expiry, then upserts the user and issues a session cookie. |

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| PUT returns `503 SSO_ENCRYPTION_KEY must be set` | The env var is missing on the backend. Set a 32-byte key and restart. |
| PUT returns `400 OIDC discovery failed: ...` | The issuer URL doesn't serve `/.well-known/openid-configuration`, or the discovery document's `issuer` field doesn't match the URL you entered. Double-check trailing slashes. |
| PUT returns `400 Domain ... already claimed by another team` | Another team has already configured an SSO connection that lists the same domain. Domains are unique across the installation. |
| PUT returns `400 Domain ... is a public mail provider` | `gmail.com`, `outlook.com`, etc. cannot be claimed. Use your company's own domain. |
| Login redirect lands on `/auth/error?reason=sso_unavailable` | OIDC discovery failed at login time (network, IdP outage). Check backend logs for the sanitized error message. |
| Login redirect lands on `/auth/error?reason=state_mismatch` | State/nonce cookies were dropped or tampered with. Usually means a cross-origin cookie issue — verify `BACKEND_URL` matches the origin serving the backend. |
| Login redirect lands on `/auth/error?reason=not_provisioned` | The SSO connection has `autoProvision=false` and the user isn't already in the team. Add them via the normal team-member flow first. |
| Login redirect lands on `/auth/error?reason=sso_failed` | Generic fall-through; check backend logs. ID token verification failures (bad signature, wrong audience, expired, nonce mismatch) land here. |

## Rotating or removing SSO

- **Rotate client secret**: paste a new secret into the form and save. The
  old secret is overwritten; there is no dual-secret window, so rotate during
  low-traffic hours.
- **Change issuer**: update the issuer URL; the backend invalidates both the
  old and new issuer's discovery cache on save.
- **Disable temporarily**: toggle the **Enabled** checkbox. The connection
  row stays intact; login attempts return 404 and the discovery endpoint
  stops matching.
- **Delete**: removes the row entirely. Users who were auto-provisioned via
  SSO are *not* removed from the team and can continue to log in via other
  methods if they have them set.
