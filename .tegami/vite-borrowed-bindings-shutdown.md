---
packages:
  '@pluxel/host-vite': minor
---

# Observe Host shutdown before releasing borrowed development bindings

Export `closeHostViteSession(server)` for development bootstraps that own a Vite server and lend connections or storage through startup bindings. It stops Host update admission and preserves drain failures before the caller closes Vite and its borrowed resources.

Resolve the shutdown owner through the shared Vite environment collection, so the server returned by `createServer()` reaches the same owner installed through `configureServer`'s proxy. This also restores explicit pre-server-close draining in the production runner.
