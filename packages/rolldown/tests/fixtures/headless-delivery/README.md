# Headless document application

This application installs only `elysia()`. Two Plugins own the independent query
and PDF ingress lifetimes. `database.ts` prepares an application-owned libSQL
connection, registers its shutdown immediately, and provides a typed accessor
bound to each Host root. The PDF handler reads a database record and streams the
selected file using the request's cancellation signal.
Its generation cleanup also waits for native file streams to emit `close`:
settled Web-stream cancellation alone does not prove that file IO has finished.

`app.ts` owns both startup policy and listener configuration. Its `launch`
callback runs only after startup is accepted, and explicitly selects `publicDir`.
The same application source is used for standalone and modules delivery.

The runnable receiver test is [`headless-delivery.test.ts`](../../headless-delivery.test.ts).
It packs actual SDK tarballs, installs them outside the repository, and builds
the application through the public `pluxel()` entry. Its generated package
manifest declares ordinary version ranges; only the test's pnpm overrides point
to local tarballs. The application dependencies are Core, Host, Services,
Elysia, its TypeBox/exact-mirror/openapi-types peers, Valibot, and `@libsql/client`.
Commands, Workbench, and managed Database are not installed as services.

Standalone selects `managedDatabaseDrivers: []` and traces `@libsql/client` as an
application dependency. Modules keeps normal package imports and uses the
`elysiaSharedPackages` metadata in `start.mjs`; no service code is imported before
the native loader has established shared identities.

The test moves each complete delivery and deletes the original source and
compiler installation before running `verify.mjs`. It checks native SQL,
business 404 preservation, explicit SPA fallback, PDF byte delivery,
disconnect/shutdown cancellation, and database cleanup after both successful and
rejected startup. No SQL or resource preparation happens at build time.

Run from `packages/rolldown` after the affected SDK packages have been built:

```sh
mise exec -- vp test run tests/headless-delivery.test.ts
```

To exercise the same receiver in an installed container runtime, explicitly
select an image with Node 24 and compatible native libraries:

```sh
PLUXEL_HEADLESS_IMAGE=docker.io/library/node:24-bookworm-slim \
  mise exec -- vp test run tests/headless-delivery.test.ts
```

The container has no network, mounts the delivery read-only, and writes databases
and event logs only to its separate data directory. A successful glibc Linux x64
run does not establish musl or ARM compatibility.
The container daemon must be able to read the temporary directory; in sandboxed
editors, set `TMPDIR` to a shared host path. The package test task preserves it.
