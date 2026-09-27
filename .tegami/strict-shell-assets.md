---
packages:
  '@pluxel/workbench': patch
  '@pluxel/services': patch
---

## Validate packaged Shell assets and preserve static IO failures

Shell builds now verify the declared entry, complete manifest references and files in the selected package layout. Invalid manifests fail instead of selecting another entry. Static file IO errors return HTTP 500 with server-side diagnostics; missing files remain 404 or eligible SPA navigation fallbacks.
