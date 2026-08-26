# ECharts plugin design

`@pluxel/echarts` is the first consumer of Pluxel's shared worker-task capability. ECharts is not a
runtime special case: the plugin declares a typed worker artifact and submits cloneable jobs through
`ctx.workers`, while runtime owns thread admission and lifecycle.

## Execution boundary

- Rendering is worker-only. The whole synchronous path—ECharts layout, text measurement,
  ZRender flush and native encoding—runs off the main event loop. Moving only `encode()` would leave
  most blocking work behind.
- Native Canvas/Image instances cannot cross a worker boundary. A job contains normalized option,
  resolved theme, output policy, and `CanvasPlugin.workerSnapshot`. The worker reconstructs native
  objects through `@pluxel/canvas/worker` and rechecks allocation, decode and font availability.
- The public option graph is declarative and borrowed without mutation until render settles. Main-realm
  bytes/value/depth budgets are walked with event-loop checkpoints only after Runtime fair admission;
  one large string is also measured in cooperative chunks. Queue rejection does no graph work. Prepared borrowed input removes the redundant snapshot, bounds
  transport serialization, and the worker mutates only its transport-owned graph. `setOption` policy
  shares the same graph budget and declarative checks.
  `postMessage` serialization itself remains bounded host-thread work.
- Formatter functions, accessors, class/native objects and shared mutable memory are rejected. Clone
  failure never silently changes execution semantics or falls back to the host event loop.
- Worker cancellation terminates its thread. Jobs must therefore be independently retryable and must
  not own external side effects.

## Pool and artifact ownership

ECharts does not own or depend on a pool implementation. Its module-level `defineWorkerTask()` is lowered by the same
content-addressed Node artifact compiler used in development and production. The artifact bundles
ECharts/engine and the Canvas worker facade. Its native residual metadata records Canvas's directly
declared `@napi-rs/canvas`; an owner-aware bridge locates the Canvas package before loading the
binding, so strict dependency layouts work without making ECharts repeat that dependency. HMR gives
new jobs the new URL while in-flight jobs finish on the old module; runtime's idle worker retirement
bounds old ESM caches.

The root worker service owns one lazy pool, bounded global/per-owner queues, round-robin scheduling,
owner abort/drain and shutdown. This lets other CPU-bound renderers share the same host thread budget
instead of multiplying `availableParallelism()` per plugin. Takumi is intentionally not one of them,
because its native render API already submits asynchronous work.

## Fonts and Canvas

`FontsPlugin` remains the only font manager. ECharts consumes its current selection and registry; it
does not own upload files or choose from an independent font catalog. `@napi-rs/canvas` 1.0.x exposes
one process-wide native font registry across worker threads, while every job still carries the
selected CSS family and revision so selection and cache invalidation are deterministic. Workbench
changes affect subsequent jobs. For a concrete system/registered selection the worker also verifies
`GlobalFonts.has(family)` before rendering, so an upstream change in thread-sharing behavior fails
clearly instead of silently falling back to another font.

`CanvasPlugin` remains the resource-policy owner. Main-thread validation uses `assertDimensions()`;
the worker receives `canvas.workerSnapshot`, and the worker-safe Canvas entry applies the same
dimension, pixel and image-byte ceilings before native allocation. It is a pure adapter, not a second
CanvasPlugin lifecycle. ECharts uses ZRender text layout, so it does not import the separate Pretext
worker entry.

## Process-global ECharts state

Each worker has its own ECharts module singleton. `setPlatformAPI()` installs stable callbacks once
per JavaScript realm and resolves the active adapter through `AsyncLocalStorage`, so concurrent renders
inside a worker realm cannot use a mutable global “current render”. The ECharts
instance is always disposed and never returned.

The worker realm caches the validated platform state and most recent normalized Canvas snapshot; the main
Plugin caches default-font theme projection. Image maps remain lazy for charts without images; repeated use
of one render-local source shares a single owned native decode. Encoded worker bytes are wrapped as a
zero-copy Buffer view after transport instead of being copied a second time.

Each job owns its Canvas worker adapter. A render-local controller stops queued image work after the first
failure and prevents a late decode from mutating aggregate accounting or invoking ZRender callbacks. The
render engine waits those caller-facing image tasks; the worker handler then closes the adapter and waits
its held native decode promises before returning. This second fence is required because aborting a caller
Promise cannot preempt an already-submitted N-API task. A new job or Fonts revision therefore cannot create
a fresh scheduler while old native work is still consuming the same process capacity.

Named themes are caller-owned frozen JSON snapshots and are passed directly to `echarts.init()`;
their clone checks bytes, value count, depth and accessors before allocation can grow without bound.
Per-caller count plus generation-wide retained count/bytes prevent many valid small registrations from
accumulating without bound; dispose/caller/provider cleanup reconcile the generation counters exactly.
They never enter ECharts' irreversible global theme registry. Encoded output is checked in the worker
before transport (after unavoidable encoding). Data URL images are rewritten to short
render-local keys, bounded by distinct-source/aggregate-byte/aggregate-pixel policy, and decoded exactly
once into the ZRender placeholder under Canvas decode admission. The default aggregate is 16,777,216 pixels
(64 MiB raw RGBA), matching one default maximum Canvas surface instead of retaining four such images per
render. They never trigger implicit network/file I/O.

Worker threads are an event-loop isolation and resource-admission mechanism, not a security boundary.
A native crash can still terminate the process.
