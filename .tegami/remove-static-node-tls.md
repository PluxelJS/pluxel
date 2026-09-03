---
packages:
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-static':
    type: major
---

## Remove TLS termination from the built-in static Node launcher

Make the production Node launcher an HTTP-only application carrier and remove the
`PLUXEL_TLS_CERT`, `PLUXEL_TLS_KEY`, and `PLUXEL_TLS_PASSPHRASE` environment contract. Terminate
public TLS at an ingress, reverse proxy, or deployment platform instead of maintaining a partial
second edge configuration inside each Pluxel application.
