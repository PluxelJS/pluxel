# Security Review Brief

Review the current implementation, not the former host-configured OIDC model.

## Assets and boundaries

- `ctx.root.adminAccess` is Runtime's host-only Management gate.
- `ctx.managementAccess` is the narrow owner-bound registration surface for one authentication
  provider Plugin.
- `ctx.vault` is encrypted, owner-namespaced Plugin storage. It does not authenticate requests.
- `ctx.root.vaultAdmin` is host-only Vault lifecycle administration and is itself behind the
  Management gate when reached over HTTP.
- Workbench HTML/assets, Management RPC/SSE/HTTP, `/security`, and every Vault admin mutation are one
  protected surface.
- Plugin business HTTP routes are not protected by Management auth and must own business auth.

## Required invariants

- Local recovery exists only while the provider is absent/unready, and is granted only from the
  physical socket peer: IPv4 `127/8`, IPv6 `::1`, or an IPv4-mapped loopback address.
- A committed, running, ready provider authenticates every peer, including loopback.
- `Host`, `Forwarded`, `X-Forwarded-For`, and URL hostname never establish locality.
- A missing carrier, null peer, malformed peer, or carrier exception fails closed.
- Remote/unknown access without a committed, running, ready provider reaches only the minimal
  `/__pluxel/admin-access` document/state endpoint; it cannot load Workbench assets or Security APIs.
- `/security` has no missing-provider exception.
- Provider registration is tied to the exact Plugin generation. An initializing replacement is not
  active before commit, and stale cleanup cannot remove the committed replacement.
- Provider callbacks run under owner admission. Successful authorization retains its lease through
  the full Management response body, so stop/replacement cancels streams and drains calls.
- A provider error, malformed status/decision, or withdrawal race maps to a closed generic failure;
  it never falls back to allow.
- An insecure remote request is rejected before the ready provider is called.
- While no provider is ready, local recovery bypasses Management authentication only. It does not
  become an identity returned by the official Auth Plugin's reusable `authenticate(request)` method.

## Official authentication provider

`@pluxel/auth` supports exactly one configured mode per generation:

- OIDC Authorization Code + PKCE for browsers, with optional validated Bearer JWTs;
- local username/password;
- local username/password plus TOTP (never TOTP-only).

All authenticated identities are Management admins; Runtime has no second role model.

Vault may contain only the provider's password verifier/salt/parameters, TOTP secret and last
accepted counter, and confidential OIDC client secret. It must not contain plaintext passwords,
generated OTPs, opaque session tokens, OIDC authorization codes, state, nonce, PKCE verifiers, or
rate-limit state. Provider Vault writes are flushed before the in-memory ready snapshot changes.
Public OIDC has no client secret and does not require Vault.

Sessions, pending OIDC flows, enrollment state, rate limits, and caches are bounded and owned by one
generation. External sessions use an opaque, `HttpOnly`, `Secure`, `SameSite=Lax`, root-scoped
`__Host-` cookie. Loopback HTTP sessions use a distinct host-only, non-Secure cookie which is accepted
only with trusted `context.local`; stored session keys are token digests. Restart/stop clears every
session. Ordinary Management requests are O(1) memory lookups with no Vault read, password hash, or
OIDC discovery.

Password verification is asynchronous scrypt with fixed validated parameters, a bounded global
work queue, constant-time digest comparison, and bounded failure throttling. Unknown usernames still
execute the sole stored account's real scrypt verifier and receive the same generic credential error.
TOTP accepts a narrow time window and persists a strictly increasing counter before issuing a session.

OIDC discovery/endpoints require HTTPS. Browser flow verifies issuer, audience, nonce, state, and
PKCE. `returnTo` is same-origin and local-path only. External login/callback requires the physical
carrier to be HTTPS; forwarding headers do not upgrade transport trust.

## Entry document

The auth document is server-rendered outside the Workbench shell. It uses no-store, a restrictive
CSP, no referrer, nosniff, frame denial, strict bounded form parsing, same-origin/Fetch-Metadata
checks, and a short-lived CSRF cookie/value for POSTs. Credential failures do not distinguish an
unknown user, bad password, or bad OTP. Secrets and session values never enter URLs, logs, public
DTOs, audit messages, or changelogs.

The CSRF value is a browser form defense, not a bootstrap token. Host setup needs no printed token:
the operator creates an SSH loopback tunnel and configures the provider locally.

## Deployment caveat

An on-host reverse proxy connected to Pluxel over loopback is indistinguishable from an SSH tunnel
and would receive local recovery trust while no provider is ready. This release intentionally has no
trusted-proxy mode. Use a non-loopback private/container upstream or direct TLS termination at the
Pluxel carrier, and never attempt to repair the distinction with forwarding headers.

The production static Node listener accepts either inline PEM data or PEM file paths through paired
`PLUXEL_TLS_CERT` and `PLUXEL_TLS_KEY`; neither variable may be configured alone.
`PLUXEL_TLS_PASSPHRASE` is optional for an encrypted private key.

## Review red lines

- no header- or hostname-derived local trust;
- no local recovery bypass while a ready provider exists;
- no unauthenticated Workbench/Security asset or API exemption;
- no provider publication before the owning generation is committed and running;
- no release of provider admission before a streaming response settles;
- no auth secret in Plugin config, browser DTO, log, or ordinary persistence;
- no global protection of business Plugin routes;
- no second authentication truth in Workbench React state, Vault, or transport clients.
