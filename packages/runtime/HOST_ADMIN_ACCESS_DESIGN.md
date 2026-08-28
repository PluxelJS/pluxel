# Host Management Access

Current implementation authority:

- `services/http/HttpService.ts`: trusted physical ingress and protected-surface gate
- `services/admin-access/AdminAccessService.ts`: local recovery, provider registry and admission
- `services/admin-access/ManagementAccessService.ts`: owner-bound public provider registration
- `plugins/auth`: official OIDC, password, and password + TOTP provider

## Boundary

Runtime protects only the host Management Plane: Workbench HTML/assets and every
`/__pluxel/runtime/**` API, including Security and Vault administration. Plugin business HTTP routes
are outside this gate and keep their own authorization policy.

Production Node launchers listen on `0.0.0.0` by default. Exposure is safe because access is decided
at the physical ingress:

```text
any peer + running, ready provider
  -> provider authentication
  -> hold the provider generation lease through the response body

loopback peer + absent/unready provider
  -> allow local recovery and configuration

remote/unknown peer + absent/unready provider
  -> fail closed
  -> only /__pluxel/admin-access and its state endpoint remain reachable
```

Loopback means IPv4 `127.0.0.0/8`, IPv6 `::1`, or an IPv4-mapped loopback address. It is derived
only from `ElysiaApplicationCarrier.requestIP()`. `Host`, `Forwarded`, and `X-Forwarded-For` never
grant local access. Missing carrier metadata, malformed addresses, and carrier errors are remote.

Because an on-host reverse proxy connected through loopback is indistinguishable from an SSH
tunnel, this version does not support a loopback reverse-proxy upstream for Management. Use a
non-loopback private/container address or terminate TLS at the Pluxel carrier. There is no trusted
proxy-header mode.

An insecure remote request is rejected before a ready provider is called. The production static
Node listener can terminate TLS directly: `PLUXEL_TLS_CERT` and `PLUXEL_TLS_KEY` must be configured
together and accept either inline PEM data or PEM file paths; `PLUXEL_TLS_PASSPHRASE` is optional
for an encrypted private key.

## Provider contract

Management-enabled hosts preinstall `ctx.managementAccess`. A Plugin generation calls
`provide(provider)` once; registration is owner-bound, is visible only while that exact generation
is the committed running instance, and is withdrawn by effects cleanup. Exactly one provider node
is supported.

The provider reports a synchronous secret-free status, authenticates a body-free `Request` view
containing only URL, method, headers, and the owner-bound signal, and may serve the Runtime-owned
`/__pluxel/admin-access/**` entry document. A running provider may report
`ready:false`; it remains available to loopback setup but never opens remote Management. Once it
reports `ready:true`, Runtime calls it for every peer, including loopback.

Provider callbacks execute under Core owner admission. A successful provider admission retains that
lease through downstream handlers and the entire `Response.body`. Replacement or stop therefore
rejects new requests, aborts active streams, and waits for drain before cleanup.

## Browser flow

The auth entry is a minimal server-rendered document, not a Workbench React route. An
unauthenticated browser therefore does not load product discovery, RPC, SSE, Workbench assets, or
remote Plugin bundles.

- remote/unknown peer with no ready provider: generic SSH tunnel instructions, without lifecycle or
  Vault details;
- OIDC: Authorization Code + PKCE, state and nonce, then an opaque cookie session;
- password: username/password form and an opaque cookie session;
- password + TOTP: password plus a six-digit TOTP, with replay-counter persistence.

The official provider stores password verifiers, TOTP secrets/counters, and confidential OIDC
client secrets in its owner Vault namespace. Plain passwords, generated OTPs, sessions, OIDC
state/nonce/PKCE, rate limits, and discovery/JWKS caches are never persisted there. Sessions and
ephemeral maps are bounded and generation-local, so restart invalidates them.

Local setup is reached through an SSH tunnel and `/__pluxel/admin-access/setup`. There is no
bootstrap token. Setup POSTs still use an ordinary short-lived CSRF value; that protects a browser
form and is not a host bootstrap credential.

## Stable failures

Management API denial returns a no-store JSON response and one stable code:

- `management_local_setup_required` (`403`)
- `management_authentication_required` (`401`)
- `management_forbidden` (`403`)
- `management_authentication_unavailable` (`503`)

Workbench navigation redirects only to the same-origin `/__pluxel/admin-access` entry and carries a
validated local `returnTo`. `/security` has no setup exemption: remote callers without a ready
provider cannot read or mutate any Security/Vault endpoint.

## Host inputs

- `workbench: { enabled: true }` installs Workbench and Management.
- `workbench: false, management: {}` installs headless Management.
- omitting both installs neither plane.
- `management.pluginGroups` remains the host catalog-classification input.
- authentication policy is provided by an ordinary Plugin generation rather than host config.
- the official auth Plugin requires host `vault: {}` for local credentials or a confidential OIDC
  secret. Public OIDC does not require Vault. Vault preflight remains a host startup responsibility.
