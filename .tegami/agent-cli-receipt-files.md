---
packages:
  '@pluxel/agent-sdk': minor
  '@pluxel/cli': minor
---

## Save and recover agent operation receipts through files

Support `--receipt-file` on `dev run` and `dev hmr`, saving the original receipt to a new private file before submission. `script result` and `script cancel` can now read that file directly, preserving the original connection, instance and request identity. Reject ambiguous or invalid receipt input before authentication or connection.

Return one `invalid_input` JSON error with exit code 1 for a missing or unknown `script` subcommand and unknown group options, instead of silent success or duplicate text diagnostics. Command help remains lazy.

Unknown `dev` subcommands also return one JSON error. Terminal failure hints now refer to `--instance` and `pluxel script result`, while ordinary SDK callers retain their Node-oriented diagnostics.
