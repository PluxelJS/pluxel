# @pluxel/core-di

> Status: internal/private prototype. This package exists to validate a new DI kernel shape for `@pluxel/core`, not to replace `diod` in one step.

`@pluxel/core-di` is a design-first workspace package for a lighter DI kernel with these priorities:

- small kernel surface
- explicit access from the outside
- incremental graph updates as a first-class concern
- semantics that fit Pluxel core/plugin orchestration better than a general-purpose DI container

Current status:

- prototype runtime is in use by `@pluxel/core`
- internal graph storage is slot-backed and still being optimized aggressively
- benchmark command: `pnpm --filter @pluxel/core-di bench`
- benchmark confidence: `PLUXEL_DI_BENCH_ROUNDS=3 pnpm --filter @pluxel/core-di bench`
- latest benchmark report: `./benchmarks/core-di-vs-diod.md`
- design source of truth: `docs/proposals/README.md`
- implementation design: `./DESIGN.md`

This package should stay private until the design is proven against real core/plugin lifecycle needs.
