---
packages:
  '@pluxel/core':
    type: major
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-dynamic':
    type: major
  '@pluxel/runtime-static':
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

## Replace Workbench with the WS-only capability profile

Workbench and Management now share the fixed `/__pluxel/runtime/session` WebSocket endpoint and
one connection-owned Cap'n Web capability graph. The previous HTTP batch, SSE, grant lookup, and
transport fallback APIs are removed.

Plugin UI is now declared with flat `View` and provider-owned `Attachment` descriptors, published
once by the owning Plugin, and opened as fresh Cap'n Web targets. Renderers are zero-prop React
Bridge entries that access their exact descriptor through `useWorkbench()`.

Workbench delivery now uses one fixed MF2 Manifest/Snapshot profile with generated exact-descriptor
Bridge exposes, immutable producer inventories, and platform-owned singleton shares. Static and
dynamic runtimes consume the same producer artifacts; custom renderer modules, shell protocol
metadata, and runtime artifact replacement are removed.

Static integration tests can open the production Node Runtime Session carrier with an origin-aware,
disposable test connection instead of weakening the WebSocket origin boundary.

Management config presentations and config results are validated into ordinary, deeply frozen
portable records before crossing Cap'n Web, including defaults produced from null-prototype config
maps.

The official font-backed renderers now place the Fonts provider's Attachment directly. Font
collections remain a Fonts domain model exposed through its Cap'n Web API, not a Workbench platform
resource.
