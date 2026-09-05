---
packages:
  '@pluxel/runtime':
    type: minor
  '@pluxel/runtime-static':
    type: minor
  '@pluxel/runtime-dynamic':
    type: minor
  '@pluxel/create':
    type: major
---

## Add stable named development origins

Recognize validated Portless listener metadata without weakening explicit Pluxel listener policy. Static
and dynamic Vite hosts now present the application and Workbench as distinct paths on one stable origin,
preserving one listener, one HMR graph, and same-origin runtime sessions.

Generated workspaces pin Portless locally and use it for the default development command, with direct and
environment-controlled bypasses for environments that do not want the named ingress.
