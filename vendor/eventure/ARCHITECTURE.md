# Eventure Architecture

This file is a compact reading guide for humans and LLM agents.

## Read Order

1. `src/types.ts` - public type vocabulary: event descriptors, listeners, results, positions, options.
2. `src/eventified.ts` - multi-event emitter storage, registration, emit/query/result APIs.
3. `src/channel.ts` - single-event variant with the same registration and emit model.
4. `src/eventureScope.ts` and `src/channelScope.ts` - fluent `when(...).at(...).once(...)` / `at(...).when(...).many(...)` registration scopes.
5. `src/ext/*` - optional execution modes built over listener arrays: `emitAll`, `fire`, `waitFor`, `waterfall`, limited listeners.
6. `src/core/listener.ts` and `src/core/registration.ts` - low-level helpers shared by the public classes.

## Core Boundaries

- `eventified.ts` and `channel.ts` own listener storage and the hot `emit` loops.
- Scope files are registration-only. They must not add work to the emit path.
- `src/core/listener.ts` owns listener metadata symbols, listener wrapping, promise-like checks, sync error policy, and immutable listener-array writes.
- `src/core/registration.ts` owns listener insertion positions, max-listener normalization, unsubscribe handles, dispose support, and `AbortSignal` binding.

## Performance Rules

- Listener arrays store functions only. Do not store records in the emit path.
- `emit` should keep direct indexed loops and the existing `args.length` switch.
- Fluent scopes can allocate because they are registration-side API objects.
- Keep new shared helpers out of `emit` unless a benchmark proves the call boundary is free or beneficial.
