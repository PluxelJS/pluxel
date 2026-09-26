# Commands implementation

The public contract and examples live in [README.md](../README.md). The package owns the validated local call, name registry, and optional protocol projections. Carriers own publication, authorization, output limits, and presentation.

## One input plan

The author schema is compiled once by identity. The plan shares a normalized frozen JSON projection, validator, defaults, and codec. Definition captures the name, trimmed description, schema plan, and handler. Mutating the original config later cannot change the command. Input validation accepts strict JSON, clones it, fills declared defaults, validates the wire shape, and decodes once. Decode failures return `INPUT_VALIDATION`; the handler never receives invalid input.

## Result boundary

The handler must return an upstream Better Result. Its Ok value is local business data and is never scanned, flattened, or encoded here. Its Err must contain a valid `CommandFailure`. Malformed results and thrown errors return `INTERNAL`; diagnostic causes remain local. No logger is installed by the kernel. Configuration and argv syntax continue to raise `CommandError` at their own boundaries.

Each call composes the caller signal with an absolute deadline into a signal delivered to the handler. The first cancellation reason determines `ABORTED` or `TIMEOUT`. Validation checks cancellation before the handler. Once the handler starts, the kernel waits for its completion and preserves any valid Result it returns. Only a rejection caused by this call's cancellation maps to cancellation failure. Timers and listeners are released on completion.

## Registry and argv

The registry preserves revision-cached snapshots, synchronous ordered reentrant notifications, and subscriber isolation. `snapshotCommand()` validates and captures one execute function and a detached frozen descriptor without registry state, preserving the receiver and publication marker. Registries and carrier definitions share this operation. A registration captures one implementation and descriptor. Disposal makes that handle permanently unavailable; dynamic lookup alone follows a later registration. Disposal does not alter calls already admitted.

Argv binds an existing command and only constructs a candidate. The command still validates the candidate. Route syntax failures stay in argv; output display belongs to the caller. The router uses longest-prefix lookup and has a revision-cached help list.

Protocol projections have independent `/mcp` and `/capnweb` entries. Neither the kernel nor MCP loads Cap’n Web. Services uses the framework-only `/internal` Result check to supervise carrier handlers with the same failure contract as `defineCommand()`.
