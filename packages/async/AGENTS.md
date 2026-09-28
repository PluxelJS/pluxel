# Maintenance rules

Read README.md for the public contract. Public types and JSDoc live beside each implementation.

- Two independent, runtime-dependency-free subpaths: `grfn` and `iter`. No root barrel.
- Change `tsdown.config.ts` entries, build, then commit generated exports. Source condition is `@pluxel/source`.
- Tests import public subpaths. Do not add aliases, TS paths, pretest builds, custom test runners, or duplicate type fixtures.
- Keep names, argument order and defaults stable. Prefer an ordinary async function to a new DSL or overload.
- `Ref<T>` describes a result; it is not a Promise. References stay graph-local. Shared work is per invocation only.
- Compile reachable ancestors once. Do not put graph discovery or definition-map lookups into the run loop.
- `failure: 'early'` is not cancellation. Keep `drain` for callers that own child task lifetimes.
- `concurrency` bounds admitted but undelivered items, including a pending read. Mapper completion alone does not free a slot.
- Serialize upstream `next()`. Early exit/error aborts cooperatively, drains work, then closes upstream; never replace a primary error with a cleanup error.
- Prefer a test proving a regression/invariant to more copies of happy-path tests. Use gates, not wall-clock sleeps.
- Do not add retry, persistent caches, graph visualization, global scheduling, hooks, or speculative compatibility layers.

Commands: `pnpm test` (source + types), `pnpm build` (also runs the installed-package smoke), `pnpm bench` (optional).
Tests must run after deleting dist/. Keep benchmark claims scoped to what was actually measured.
