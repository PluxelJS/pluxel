---
packages:
  '@pluxel/host': major
  '@pluxel/host-vite': major
  '@pluxel/rolldown': major
  '@pluxel/services': patch
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

# Import Better Result and keep script workflows ordinary

Business Result constructors and optional composition come from
`@pluxel/core/better-result`. SDK controls directly return successful values and
throw `ScriptError`; ordinary scripts return plain JSON. The SDK does not expose
a second Result namespace.

Uploaded factory format 4 binds the canonical Better Result, verified control
factory and public Host SDK namespaces to the receiver. Native Result and
ScriptError identities remain shared without bundling another framework runtime.
Older factories are rejected; recompile uploaded scripts. Other framework runtime
imports and separate Better Result copies remain rejected.
The compiler converts standard ESM declarations into its own strict factory,
preserving namespace identity and source maps without bundler interop helpers.

Update Vite callers, CLI and starter instructions, examples, capability reports,
and source-free receiver tests to express the same contract.
