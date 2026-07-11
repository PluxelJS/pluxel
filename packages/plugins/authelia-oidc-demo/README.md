# Authelia OIDC Demo

Standalone OIDC integration demo under `packages/plugins`, separate from `plugins-host` like
`static-commercial-demo`.

It demonstrates two different OIDC paths against the same local Authelia issuer:

- Pluxel host admin access with the `pluxel-host-admin-access` client.
- A plugin-owned business login with the `pluxel-business-demo` client.

Start Authelia:

```sh
cd packages/plugins/authelia-oidc-demo/authelia
docker compose up
```

Start the Pluxel static host:

```sh
pnpm --filter @pluxel/plugins-authelia-oidc-demo static
```

This command starts the host-owned Vite server with `staticRuntimeVitePlugin`; plugin TypeScript is
always evaluated through the Pluxel Vite/Rolldown transform chain.

Credentials and URLs:

- Authelia user: `demo` / `password`
- Both OIDC client secrets: `password`
- Authelia issuer: `http://127.0.0.1:9091`
- Pluxel host: `http://127.0.0.1:3310`

Business login entry:

```text
http://127.0.0.1:3310/__pluxel/plugins/AutheliaOidcDemoPlugin/authelia-oidc-demo/business/login
```

Authelia config details, including the host-management OIDC policy, live in
[authelia/README.md](./authelia/README.md).
