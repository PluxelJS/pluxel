---
packages:
  '@pluxel/host': major
  '@pluxel/services': patch
  '@pluxel/workbench': patch
---

# Decouple public origins from the development proxy

Replace the Portless-specific environment contract with `hostEnv.publicOrigin`:
`PLUXEL_PUBLIC_ORIGIN` explicitly configures any reverse proxy, with automatic discovery
from Pitchfork's `PITCHFORK_URL`. Listener settings independently accept `HOST` and
`PORT` beneath explicit Pluxel overrides, including when no proxy is enabled.
Vite URL output and Vite/native management same-origin validation share this trusted startup
origin while carrier URLs retain the physical listener address.
