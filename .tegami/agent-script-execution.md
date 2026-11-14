---
packages:
  '@pluxel/host': minor
  '@pluxel/host-vite': major
  '@pluxel/cli': major
  '@pluxel/rolldown': minor
  '@pluxel/services': major
  '@pluxel/plugin-auth': minor
  '@pluxel/workbench': patch
  '@pluxel/create': major
---

## Execute ordinary TypeScript against the current Host

Add the portable `@pluxel/host/agent` SDK and one run executor for Vite project
modules and uploaded Node JavaScript factories. Scripts receive `(sdk, run)` and
return ordinary values or promises. Configuration and policy use the same Host
operations and report projections as Management; reads retain sources, saved and
applied versions, conflicts, and partial failure details. Bounded log reads and
waits follow the run's cancellation and resource lifetime.

Replace `@pluxel/host-vite/console` and its definition helper with type-only
`ProjectScript` and `ProjectSdk` at `@pluxel/host-vite/project`. Use
`sdk.plugin(Constructor)` for current project implementations and `sdk.dev.ctx`
for borrowed Context capabilities. Async controls return the shared Better Result;
use ordinary `await` and `isErr()` for expected failures. Import its constructors
from `@pluxel/core/better-result` when needed. Rename the Vite and development profile execution option to
`scripts`; the prior option and JSON command protocol are removed. Templates,
project scripts and generated agent instructions use these entries.

## Compile on the client and query the original execution owner

`pluxel script run` type-checks and compiles a JavaScript factory with
`@pluxel/rolldown/scripts`, then authenticates to the explicit Management session
endpoint. Node receivers need no Vite, source tree or compiler. Enable execution
explicitly with `managementHttp({ scripts: true })` or the corresponding preset
option. Workbench and standalone clients share the endpoint and authentication
implementation.

Both transports use the same Cap'n Web control target and protocol version 2.
Shared Cap'n Web identity is selected by Host, so headless management and script
receivers can build and run without a Workbench installation.
Receipts identify the original endpoint, instance, run and request hash; clients
save them before submission and never replay an uncertain mutation. Duplicate
content returns the original run, conflicting content fails, and expired results
retain an identity tombstone for the owner's lifetime. Disconnecting releases the
connection; cancellation, authorization withdrawal and owner shutdown wait for
actual cooperative settlement. Failed runs retain committed effects and original
source locations without rollback or automatic retry.

Authentication providers can supply a distinct authorization signal. Credential
rotation and explicit revocation cancel that subject's runs while ordinary
transport disconnection permits authenticated receipt queries.
