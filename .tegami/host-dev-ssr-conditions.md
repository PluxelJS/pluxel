---
packages:
  '@pluxel/host-dev': minor
  '@pluxel/rolldown': minor
  '@pluxel/services': patch
---

## Isolate Host development in its own Vite environment

Host development owns the dedicated `pluxel` environment. Application modules, dynamic plugins, and the development console share its runner, source conditions, singleton identities, semantic collector, and queued HMR. Default SSR and third-party `ssrLoadModule` retain Vite's own environment and are unaffected by Host module policy; custom SSR factories can coexist.

Vite resolves modules before the Host environment chooses native Node evaluation for CommonJS, native modules, and explicit singletons. Vite owns the runner and cleanup. Services scope database source transforms and transport externalization to the Host environment, and HTTP diagnostics preserve the runner's source maps without reprocessing them through another environment's graph.

Remove incidental public runner, classifier, and invalidation helpers from `@pluxel/host-dev/vite`. Use `host()` or the Services preset; combine `hostSingletons()` with that Host environment. The reserved `pluxel` environment factory cannot be replaced. Concrete source pipelines now bind their semantic collector to one named environment (default `ssr`). Legacy decorator syntax remains project-wide because Vite does not expose per-environment OXC options.

Initial Host and recovery failures now render their original stack, nested causes, and aggregate errors in Vite's terminal message, preserving the original Error for Vite's reporting bookkeeping.

Host and recovery diagnostics now share one internal structured logging entry that follows the current Host logger across replacement, falling back to the user's Vite logger before startup. It does not replace `customLogger` or install additional sinks.
