---
packages:
  '@pluxel/host': major
  '@pluxel/host-dev': major
  '@pluxel/rolldown': patch
---

## Consolidate Host application and development integration entries

Import `runHostApplication` from `@pluxel/host`, alongside the existing application contracts.
Remove the duplicate `/application` entry and update generated production launchers.

Host-dev exposes one explicit `/internal` entry for framework integration. Console execution,
IPC protocol, server and attachment implementations are private, with package-local tests
importing their source directly. The public console and Vite entries remain separate.

Portable execution snapshots and their validators now cross the browser/server boundary through `@pluxel/host/internal/protocol`. Management clients use this dependency-free entry instead of the server integration barrel; the duplicate execution exports and Management forwarding module are removed. Browser builds no longer traverse Host source loading and Node built-ins to validate update reports.
