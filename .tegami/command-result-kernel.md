---
packages:
  '@pluxel/commands': major
---

## Make Command execution return Better Result

Define Commands with name, description, input, and a Result-returning execute handler. Direct, registry, and argv calls now return `Result<T, CommandFailure>`. A fixed registration handle stops when disposed, and dynamic name lookup follows the current registration. Remove the obsolete `InstalledCommand` alias. Cancellation reaches the handler and cannot overwrite a completed Result. Remove output schemas and behavior metadata from Command definitions.
The execution boundary rejects a returned Result whose status conflicts with its branch methods.
Absolute deadlines beyond the platform timer range remain scheduled until their actual time instead of expiring immediately.
Framework deadline cancellation remains `TIMEOUT` when its signal passes through owner or carrier signal composition into a nested Command.
Use `toCli()` to compile an argv projection before publishing it with `router.bind()`; the router now accepts that projection instead of a Command and separate syntax options.
