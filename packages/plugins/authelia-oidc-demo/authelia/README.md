# Authelia OIDC Demo

Local Authelia setup for `packages/plugins/authelia-oidc-demo`.

Demo credentials:

- Authelia user: `demo` / `password`
- Pluxel host verification client: `pluxel-host-verification` / `password`
- Business app client: `pluxel-business-demo` / `password`
- Authelia issuer: `http://127.0.0.1:9091`
- Authelia storage: SQLite at `/config/db.sqlite3`

The committed config is intentionally simple and demo-only. Do not reuse the secrets or signing key
outside local examples.

Authelia reads [config/configuration.yml](./config/configuration.yml),
[config/users_database.yml](./config/users_database.yml), and the demo OIDC signing key in
[config/oidc.private.pem](./config/oidc.private.pem). The compose file enables Authelia's
`template` config filter so `configuration.yml` can load that PEM without inlining it.

## Pluxel Host Verification OIDC

Use the `pluxel-host-verification` Authelia client for Pluxel's built-in host/control-plane
verification.

Runtime config:

```ts
management: {
	enabled: true,
	access: {
		exposure: 'public',
		oidc: {
			issuer: 'http://127.0.0.1:9091',
			audience: 'pluxel-host-verification',
			requiredClaims: { groups: 'pluxel-admins' },
		},
	},
},
```

OIDC can stay in config while the management surface is disabled or private. Pluxel only fails fast
when management is enabled and `access.exposure` is `public` without OIDC:

```ts
management: {
	enabled: false,
	access: {
		exposure: 'private',
		oidc: {
			issuer: 'http://127.0.0.1:9091',
			audience: 'pluxel-host-verification',
		},
	},
},
```

This path validates Bearer JWTs issued by Authelia. It does not create a business login session.

## Business OIDC Login

After the demo runtime starts, open:

```text
http://127.0.0.1:3310/__pluxel/plugins/AutheliaOidcDemoPlugin/authelia-oidc-demo/business/login
```

That route uses the separate `pluxel-business-demo` Authelia client and redirects back to:

```text
http://127.0.0.1:3310/__pluxel/plugins/AutheliaOidcDemoPlugin/authelia-oidc-demo/business/callback
```

Check the resulting plugin-owned business session:

```text
http://127.0.0.1:3310/__pluxel/plugins/AutheliaOidcDemoPlugin/authelia-oidc-demo/business/me
```

The business login owns its callback, cookie, token exchange, and app authorization rules. Keep it
separate from `ctx.root.verification.authorize()`, which only protects the Pluxel host/control-plane.

## Vault Usage

The plugin stores demo OIDC settings and business sessions in the `AutheliaOidcDemoPlugin` vault
namespace. Vault is encrypted persistence only:

- OIDC does not unlock vault.
- Vault does not inherit OIDC sessions.
- A host that enables vault-dependent plugins should bootstrap vault before activating them.

Official Authelia references:

- SQLite storage: <https://www.authelia.com/configuration/storage/sqlite/>
- OIDC clients: <https://www.authelia.com/configuration/identity-providers/openid-connect/clients/>
