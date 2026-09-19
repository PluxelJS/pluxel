---
packages:
  '@pluxel/host': patch
  '@pluxel/host-dynamic': patch
  '@pluxel/host-dev': patch
  '@pluxel/logging': patch
  '@pluxel/management': patch
  '@pluxel/workbench': patch
  '@pluxel/rolldown': patch
---

## Share framework identities with the application

Declare Core, Host and shared service/management contracts as peer dependencies with local
development copies. The compiler likewise consumes the application's Core lowering ABI.
Workbench declares React, Mantine and React Bridge as shared platform peers; owned implementation
libraries remain normal dependencies. This prevents integrations from silently installing their own
framework identities and makes compatible application dependencies explicit.
