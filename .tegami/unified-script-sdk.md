---
packages:
  '@pluxel/agent-sdk': major
  '@pluxel/host': major
  '@pluxel/host-vite': major
  '@pluxel/rolldown': major
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

## Use one Script SDK with native Context access and throwing control operations

Node and Vite scripts now use `Script` from `@pluxel/agent-sdk/host` and borrow the
current RootContext through `sdk.ctx`. Remove `@pluxel/host-vite/project`,
`ProjectScript`, `ProjectSdk`, `sdk.dev`, and `ScriptScopeError`.

SDK controls return their successful values directly and throw `ScriptError` for
expected failures. `error.details` and execution receipt `error.details` preserve
the domain code, persistence state, and complete reports. Business methods retain
their original return and failure contracts, including Better Result when used.
Instance acquisition returns `{ instance }` to preserve business `then` members.

Uploaded factories use format 4 and bind the receiver's public Host SDK namespace,
so `instanceof ScriptError` works in both loading modes. Recompile older artifacts.
Cancellation, generation admission, operation draining, and resource ownership
remain shared by the single Host executor.

Workspace setup and generated application and plugin instructions use this same
Script contract; starter and project examples return ordinary JSON values.
