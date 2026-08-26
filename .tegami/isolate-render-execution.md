---
packages:
  '@pluxel/runtime':
    type: major
  '@pluxel/canvas':
    type: major
  '@pluxel/echarts':
    type: major
  '@pluxel/fonts':
    type: major
  '@pluxel/takumi':
    type: major
---

## Isolate render execution and bound preparation work

Make Worker task input ownership explicit with snapshot-by-default and opt-in borrowed inputs, and
reject borrowed transfers whose ownership contract would be ambiguous. Add admission-gated cooperative
input preparation so queue rejection occurs before domain graph walks and snapshots. Replace the former
pool dependency with a narrow persistent worker-thread executor that separates caller result settlement
from real worker reuse/termination settlement, so cancellation never releases capacity early.

Clarify that Takumi raster/SVG tasks consume the process-shared libuv pool rather than an owned
static-render pool, reserve default libuv capacity for other Node work, and discard results after
late cancellation when an already-running N-API task cannot be preempted.

Run ECharts exclusively in the shared Worker pool, require bounded declarative option graphs, and
remove the host-thread fallback. Mark Canvas host-thread allocation and text preparation primitives
with `Sync` names, remove the unbudgeted root Image placeholder factory, and retain the concise API on
its trusted worker-only adapter.

Make Fonts registration, path reads, and portable-font copies asynchronous and cancellable, with
cooperative large-byte snapshots, hashing and managed-record copies plus a bounded final registry
commit. Bound caller font work with owner-fair queues, bound the serialized managed queue, and cap
provider native registration count/bytes. Bound Canvas native decode admission without reusing slots
before uncancellable work settles. Separate root and per-worker Canvas decode admission, serialize native
decode within each worker by default, and make caller-owned worker adapters closeable so ordinary failures
wait for held native work before the thread accepts another render. Admit Takumi renders before snapshot
and preparation, yield during large copies and tree walks, and add explicit stylesheet, image, font, node,
depth, byte, pixel, and queue ceilings. Cap ECharts retained theme aggregates and encoded worker output before transport.
Decode ECharts placeholders in place once, bound per-render image count/aggregate bytes/aggregate
pixels, measure large ECharts/Takumi strings cooperatively, avoid Takumi's redundant structured-content
clone, and read font paths through bounded chunked file handles with managed-record preflight validation.
Reduce the default ECharts aggregate decoded-image budget from four maximum Canvas surfaces to one, and
abort the remaining render-local image tasks after a failure without allowing late callbacks to update state.
