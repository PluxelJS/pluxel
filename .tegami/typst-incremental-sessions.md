---
packages:
  '@pluxel/typst': minor
---

# Retain native Typst document compilers

Document sessions now own bounded dedicated compiler threads, retaining native compiler and shadow-file state across updates. `update` accepts an optional full `template` replacement, including deleted files. Fonts remain fixed for the session; reopen to change fonts. Running cancellation closes that session after thread exit. NodeModules supplies the compiler artifact; shared Workers installation is no longer required.
