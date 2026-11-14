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

Remove `sdk.Result`. Control operations retain their native
`Promise<Result<Value, Error>>` contract. Scripts use ordinary `await`, narrow
expected failures with `isErr()`, and can return an existing control result or
plain JSON without constructing a new Result.

When constructors or optional composition are needed, import them from
`@pluxel/core/better-result`. Uploaded factory format 2 binds that exact entry to
the receiver's shared module, preserving native Result identity without bundling
another runtime. Format 1 is explicitly rejected; compile uploaded scripts again.
Other framework runtime imports and separate Better Result copies remain rejected.
The compiler converts standard ESM declarations into its own strict factory,
preserving namespace identity and source maps without bundler interop helpers.

Update Vite callers, CLI and starter instructions, examples, capability reports,
and source-free receiver tests to express the same contract.
