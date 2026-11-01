---
packages:
  '@pluxel/services':
    type: minor
  '@pluxel/host-vite':
    type: patch
---

# Preserve native transport and application configuration

`listenElysia()` accepts native srvx TCP/TLS options, plugins, middleware, proxy handling, body limits and error handlers. Host dispatch and shutdown remain managed; custom transports can use `createElysiaHandler()` with srvx directly.

Listener addresses and request metadata use the actual TCP port, including HTTPS default ports.

Vite application assembly now forwards `configSync` to the Host instead of dropping it.
