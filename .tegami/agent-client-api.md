---
packages:
  '@pluxel/agent-sdk': minor
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

# Call existing Hosts directly from Node

Add `@pluxel/agent-sdk/client` with `listHosts`, `runScript`, `controlHmr`, `getScriptResult`, `cancelScript` and `syncPluginControl`. Local and remote execution share submission, receipt validation and waiting. Each call closes its connections; aborting a client call retains accepted Host work. Await `onPrepared` to persist a receipt before submission, and use that original receipt for recovery or explicit cancellation.

CLI dev/script commands consume the same client implementation. CLI retains terminal output, credential-file input and process startup. Source queries remain standalone `/source` functions; `/host` retains portable in-process operations. Generated project instructions document these execution boundaries.
