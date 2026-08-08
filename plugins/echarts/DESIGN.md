# ECharts plugin design

`@pluxel/echarts` is the first consumer of Pluxel's shared worker-task capability. ECharts is not a
runtime special case: the plugin declares a typed worker artifact and submits cloneable jobs through
`ctx.workers`, while runtime owns thread admission and lifecycle.

## Execution boundary

- `execution: 'worker'` is the default. The whole synchronous path—ECharts layout, text measurement,
  ZRender flush and native encoding—runs off the main event loop. Moving only `encode()` would leave
  most blocking work behind.
- Native Canvas/Image instances cannot cross a worker boundary. A job contains normalized option,
  resolved theme, output policy, and `CanvasPlugin.workerSnapshot`. The worker reconstructs native
  objects through `@pluxel/canvas/worker` and rechecks allocation, decode and font availability.
- `execution: 'inline'` is explicit compatibility for formatter functions and native objects. Clone
  failure never silently changes execution semantics.
- Worker cancellation terminates its thread. Jobs must therefore be independently retryable and must
  not own external side effects.

## Pool and artifact ownership

ECharts does not depend on Tinypool. Its module-level `defineWorkerTask()` is lowered by the same
content-addressed Node artifact compiler used in development and production. The artifact bundles
ECharts/engine and the Canvas worker facade. Its native residual metadata records Canvas's directly
declared `@napi-rs/canvas`; an owner-aware bridge locates the Canvas package before loading the
binding, so strict dependency layouts work without making ECharts repeat that dependency. HMR gives
new jobs the new URL while in-flight jobs finish on the old module; runtime's idle worker retirement
bounds old ESM caches.

The root worker service owns one lazy pool, bounded global/per-owner queues, round-robin scheduling,
owner abort/drain and shutdown. This lets future Takumi or other CPU/native plugins share the same
host thread budget instead of multiplying `availableParallelism()` per plugin.

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
per JavaScript realm and resolves the active adapter through `AsyncLocalStorage`, so concurrent inline
renders and future per-worker concurrency cannot use a mutable global “current render”. The ECharts
instance is always disposed and never returned.

Named themes are caller-owned frozen JSON snapshots and are passed directly to `echarts.init()`;
they never enter ECharts' irreversible global theme registry. Data URL images are rewritten to short
render-local keys, decoded under Canvas limits, and never trigger implicit network/file I/O.

Worker threads are an event-loop isolation and resource-admission mechanism, not a security boundary.
A native crash can still terminate the process.
