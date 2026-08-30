---
packages:
  '@pluxel/auth':
    type: major
---

## Migrate official authentication to Cap'n Web challenges

Replace request-by-request Management authorization and generic authentication HTTP pages with disposable password/TOTP challenge sessions, narrow OIDC navigation/callback handlers, and single-use cookie commit tickets. Remove the reusable bearer/authenticate surface and OIDC bearer audience configuration.

Add the browser-safe `@pluxel/auth/workbench` entry and the loopback-only `AuthWorkbench.setup` Direct View for first password, password + TOTP, or confidential OIDC credential provisioning over the existing Cap'n Web/WebSocket session.
