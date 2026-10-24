# Pre-1.0 Context snapshot

This directory preserves the last complete implementation of the Context service registry used
before the immutable capability-host kernel. The snapshot comes from commit `8b06c75d`.

The source retains the historical behavior as a performance reference. Its retired API is not part
of the package's normal regression suite; current contracts are tested in `../tests/`.

## Boundary

- This is executable architecture history, not a supported API or compatibility layer.
- Nothing under `legacy/` is exported by `@pluxel/context`, entered into tsdown, or included by the
  package `files` list.
- Production code must not import it. Only the historical benchmarks may depend on it.
- Fixes belong in the current kernel. Change the snapshot only when the repository toolchain can no
  longer execute it, and document such a mechanical change here.

The benchmark scripts use Node TypeScript transformation because the current kernel contains
parameter properties that strip-only execution cannot handle. The snapshot benchmark has a dedicated
ten-minute timeout for its fifteen comparison cases. The snapshot source is unchanged.

## What the snapshot modeled

The old implementation installed globally registered Service classes on `Context.prototype`.
Contexts shared a root instance cache and rebound a shared Service's mutable `ctx` property on each
access.

- `extend()` created a child owner that shared the current instance space.
- `isolate()` / `isolateKeys()` created an instance-space overlay for a selected Service subset.
- `overrideService()` rewrote a global prototype getter.
- `prepareServices()` materialized Services marked `eager` and invoked their optional `prepare()`.

The current kernel replaces those runtime choices with a host-compiled immutable shape and explicit
`root`, `scope`, and `owner-view` capability lifetimes. In particular, owner views retain a stable
owner instead of rebinding a shared object's `ctx` field.

## Performance reference

The package's typecheck still includes the benchmark source. Normal tests cover only the current
kernel, without maintaining the retired registry's behavioral contract.

The original micro-benchmark is retained separately from the direct current-versus-legacy
comparison:

```sh
vp run @pluxel/context#bench:legacy-snapshot
vp run @pluxel/context#bench:compare-legacy
```

Benchmarks report trends, not correctness or release thresholds. The comparison intentionally names
the semantic paths being measured; it must not equate old mutable owner rebinding with current stable
owner views without saying so.

The expected result is a tradeoff, not a universal win: the old globally mutable, monomorphic cached
getter can be faster because it performs less validation and offers weaker owner semantics. The
current getter spends a few additional nanoseconds to use private plan state and stable per-owner
views, while current child/scope creation avoids the old selective-isolation mapping overlays. Keep
both sides visible when evaluating future kernel changes.
