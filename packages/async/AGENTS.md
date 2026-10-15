# Maintenance rules

Read README.md for orientation and docs/guide.md for the public contract. Public types and JSDoc live beside each implementation. Keep this package usable without Pluxel runtime; the framework docs page summarizes capabilities and links here for detailed contracts and recipes. Ship docs/ and examples/ with the package, and keep examples on public imports.

- Six runtime-dependency-free subpaths: `grfn`, `iter`, `limit`, `retry`, `singleflight`, `wait`. No root barrel.
- Change `tsdown.config.ts` entries, build, then commit generated exports. Source condition is `@pluxel/source`.
- Tests import public subpaths. Do not add aliases, TS paths, pretest builds, custom test runners, or duplicate type fixtures.
- Keep names, argument order and defaults stable. Prefer an ordinary async function to a new DSL or overload.
- `Ref<T>` describes a result; it is not a Promise. References stay graph-local. Shared work is per invocation only.
- Compile reachable ancestors once. Do not put graph discovery or definition-map lookups into the run loop.
- `failure: 'early'` is not cancellation. Keep `drain` for callers that own child task lifetimes.
- `concurrency` bounds admitted but undelivered items, including a pending read. Mapper completion alone does not free a slot.
- Serialize upstream `next()`. Early exit/error aborts cooperatively, drains work, then closes upstream; never replace a primary error with a cleanup error.
- Prefer a test proving a regression/invariant to more copies of happy-path tests. Use gates, not wall-clock sleeps.
- Keep retry finite and explicitly authorized by shouldRetry; attempts counts the initial call.
- Limiters retain slots until work settles. close stops admission and gracefully drains accepted work; it does not swallow run failures or cancel IO.
- singleflight fixes one key/result domain; run supplies a task and the first task wins for a pending key. get/size only observe; drain snapshots; close stops admission. Waiter cancellation never owns shared work. Completed keys are released, not cached.
- sleep and waitFor cancel waiting; until and retry await active callbacks. Preserve real results/errors and clean listeners/timers.
- Do not add persistent caches, graph visualization, global scheduling, reactive hooks, or speculative compatibility layers.

Commands: `vp run test` (source + types and the installed-package smoke, after building), `vp run build` (ESM + declarations), `vp run bench` (optional), `vp run examples` (build and run standalone examples).
Source tests must also work without dist/; use `vp test run` to check that boundary separately from the complete test task. Benchmarks build first and use native ESM via vitest.bench.config.ts to compare published artifacts without source-loader overhead. Keep benchmark claims scoped to what was actually measured.
