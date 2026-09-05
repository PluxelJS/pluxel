---
packages:
  '@pluxel/create':
    type: minor
---

## Default local development to permission-free HTTP

Generate Portless scripts that explicitly start a plain HTTP proxy on port 1355 before launching the
application. Fresh workspaces no longer require sudo, a trusted local CA, or a working OpenSSL provider
for ordinary local development; projects can still opt into HTTPS when their authentication flow needs it.
