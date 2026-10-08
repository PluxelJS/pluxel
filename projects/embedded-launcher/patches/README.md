# Embedded LLRT baseline

Pinned upstream: `awslabs/llrt` `0a10758f31eec3e5421a6b8ff1f459df1f4354c4`
(tag `v0.9.0-beta`). `build/prepare-llrt.mjs` checks this revision, applies
`llrt-embedded.patch` idempotently, then builds the upstream `stream` and
`stream/promises` JavaScript entries. Those are the two non-test runtime entries
in upstream `build.mjs:ENTRYPOINTS`; the other two entries are its test runner.
The crate keeps `VmOptions::default().module_builder` and its complete native
standard library. Features are upstream defaults plus `no-sdk`, `uncompressed`.
This is the no-AWS-SDK baseline, not a reduced Fetch/Abort implementation.

The bounded local patch:

- Exposes one process initialization function and VM globals initialization without
  installing CLI fatal handlers. The application invokes process initialization
  once, installs its spawn/rejection policy, and owns AsyncRuntime/context/loader.
- Changes both global and imported `process.exit` to throw an explicit embedded-host
  error. CLI `Vm::run*` and its fatal handlers are never called by the embedder.
- Routes timer callback errors to the existing error policy without terminating
  the entire timer scheduler. The previous `?` stranded later timers after a throw.
- Adds explicit timer cancellation and registry disposal for runtime shutdown.
  Upstream's process-global `RT_TIMER_STATE` previously never removed a runtime;
  tests now assert its count returns to zero after each destruction.
- Fixes `File::from_bytes` to use `Blob::from_bytes`, preserving arbitrary binary
  bytes when FormData wraps a Blob in a File.
- Removes the fabricated Fetch Origin header. Explicit caller headers remain under
  the upstream header policy.
- Skips compression-dictionary training in uncompressed builds: the unused
  dictionary is an empty file. Small no-SDK bundles otherwise fail zstd training.

`native/tests/runtime.rs` exercises the patched implementation through the actual
linked runtime, a local HTTP server and its native request queue. Removal requires
an upstream revision with equivalent fixes and this regression passing against it;
upgrading the tag alone is not evidence. Dependencies resolve through the application
pnpm lockfile and native Cargo.lock; prepare never installs an independent dependency
set. Vendored source and generated bundles are ignored, reproducibly fetched inputs.
