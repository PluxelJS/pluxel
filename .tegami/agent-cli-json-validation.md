---
packages:
  '@pluxel/agent-sdk': patch
  '@pluxel/cli': patch
---

## Return consistent JSON for development query argument errors

Route `pluxel dev instances` and `pluxel dev status` parser failures through the SDK's existing terminal error handler. Missing option values now produce one `{ ok: false, error }` JSON result with `invalid_input` and exit code 1, consistently with other agent commands. Help remains plain text.
