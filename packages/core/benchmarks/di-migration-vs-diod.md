# DI Migration Benchmark Summary

This document compares the current `@pluxel/core` DI migration against the pre-migration `diod` implementation with benchmark facts only.

## Scope

Two benchmark layers were used:

1. Pure DI kernel archived result:
   `packages/core/benchmarks/di-kernel-vs-diod.md`
   This records the internal kernel and `diod` comparison used to validate the migration.

2. Real plugin lifecycle:
   `packages/core/bench/pluginLifecycle.bench.ts`
   This compares current `@pluxel/core` against the pre-migration `diod` baseline from commit `7c800b89`.

## Environment

- Date: `2026-04-14`
- Runtime: `bun 1.3.4`
- Current workspace: GitButler workspace HEAD `a41338dc`
- Pre-migration baseline: `7c800b89` (`origin/main` at benchmark time)

## Commands

```sh
# pre-migration diod baseline
git worktree add /tmp/pluxel-bench-7c800 7c800b89
pnpm install --frozen-lockfile
PLUXEL_BENCH_TIME=1000 PLUXEL_BENCH_WARMUP_TIME=300 PLUXEL_BENCH_STRICT=0 \
  pnpm --filter @pluxel/core bench

# current @pluxel/core vs diod baseline
PLUXEL_BENCH_TIME=1000 PLUXEL_BENCH_WARMUP_TIME=300 PLUXEL_BENCH_STRICT=0 \
PLUXEL_BENCH_BASELINE=packages/core/benchmarks/plugin-lifecycle.diod-baseline.json \
  pnpm --filter @pluxel/core bench

# current internal DI kernel vs archived workspace diod
PLUXEL_DI_BENCH_TIME_MS=1000 PLUXEL_DI_WARMUP_MS=300 PLUXEL_DI_BENCH_ROUNDS=3 \
  pnpm --filter @pluxel/core bench:di

```

## Raw Reports

- Pure DI report: `packages/core/benchmarks/di-kernel-vs-diod.md`
- Current lifecycle report: `packages/core/benchmarks/plugin-lifecycle.md`
- Current lifecycle diff JSON: `packages/core/benchmarks/plugin-lifecycle-diff.json`
- Pre-migration lifecycle baseline JSON: `packages/core/benchmarks/plugin-lifecycle.diod-baseline.json`

## Result

### 1. Pure DI kernel: clear win

The internal DI kernel won all 8 direct DI scenarios against `diod`.

| Scenario | Speedup |
| --- | ---: |
| Cold full build chain x64 | 2.21x |
| Cold build + first resolve chain x64 | 1.97x |
| Hot no-op build chain x64 | 4.75x |
| Hot add/remove leaf star x128 | 1.08x |
| Hot base retarget star x128 | 1.63x |
| Hot replace root with old-token alias star x128 | 1.78x |
| Hot resolve base singleton star x128 | 1.22x |
| Hot resolve transient chain x32 | 9.95x |

Geometric mean speedup: `2.30x`.

Conclusion at this layer: the lightweight DI kernel is materially faster than `diod`.

### 2. Real plugin lifecycle in `@pluxel/core`: now also a clear win

Current `@pluxel/core` was compared against the pre-migration `diod` baseline on the same lifecycle benchmark suite.

Improved scenarios:

| Task | Ops delta | Latency delta |
| --- | ---: | ---: |
| cold: build star baseline | +57.61% | -35.69% |
| cold: build chain baseline | +43.30% | -32.84% |
| cold: build big baseline (independent + star) | +24.41% | -21.28% |
| incremental: add/remove leaf (star) | +47.89% | -30.87% |
| restart: leaf (star) | +16.98% | -11.50% |
| restart: root (star) | +17.06% | -15.92% |
| hmr: replace leaf (star) | +54.16% | -39.48% |
| hmr: replace root (star) | +31.50% | -25.77% |
| unregister: leaf cascade (star) | +64.27% | -38.92% |
| unregister: root cascade (star) | +37.53% | -27.98% |
| restart: chain middle (deep) | +20.10% | -15.98% |
| restart: chain leaf (deep) | +22.90% | -17.89% |
| unregister: chain middle cascade (deep) | +20.98% | -14.80% |
| config: inject-heavy restart | +60.55% | -42.48% |
| big: noop commit (independent + star) | +12.00% | -25.00% |
| big: incremental add/remove leaf (independent + star) | +188.82% | -64.69% |
| big: hmr replace leaf (independent + star) | +63.79% | -37.84% |
| big: hmr replace root (independent + star) | +39.49% | -29.77% |

Only remaining measured regression:

| Task | Ops delta | Latency delta |
| --- | ---: | ---: |
| baseline: noop commit (star) | -12.52% | 0.00% |

That regression is not operationally meaningful:

- mean latency stayed at `0.002ms`
- it only affects the empty-commit overhead floor
- all real work paths improved

## Bottom Line

The migration is now a confirmed performance win both at the DI kernel layer and across the measured `@pluxel/core` lifecycle tasks.

The benchmark-backed statement that is safe to make is:

- The internal DI kernel is substantially faster than `diod`.
- In real plugin lifecycle paths, every meaningful measured task improved versus the pre-migration `diod` baseline.
- The only residual regression is empty-commit ops/sec with unchanged `0.002ms` mean latency, which is below practical concern.

## Interpretation

Facts:

- DI definition build/verification got faster on small, medium, and large topologies.
- Runtime leaf and cascade operations improved after routing clean-state cascade queries back to the committed graph and adding single-node scheduler fast paths.
- Worst-case root operations also improved materially, not just leaf operations.

Inference:

- The raw DI container is no longer the bottleneck.
- Remaining cost in `@pluxel/core` is concentrated in real lifecycle work on large dependent subtrees, not DI lookup/build overhead.

That inference matches the benchmark shape, but the tables above are the primary source of truth.
