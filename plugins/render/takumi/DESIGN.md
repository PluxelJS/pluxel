# Takumi integration

`TakumiPlugin` exposes the upstream `takumi-js` API through three prototype methods:
`render`, `renderSvg`, and `renderAnimation`. These preserve native arguments, return values,
exceptions, and the dependency caller's lifecycle gate. They keep JSX, resource loaders,
custom Renderer instances, and WASM selection in the calling realm.

N-API asynchronous work does not move the whole render off the calling thread. JSX component
execution, HTML parsing, emoji extraction, Node-to-Rust conversion, and cold stylesheet
preparation run before native task computation. Native image decoding, layout, painting, and
encoding use the process-wide libuv pool; animation retains the upstream implementation.

## Shared Worker entry points

`renderInWorker`, `renderSvgInWorker`, and `renderAnimationInWorker` snapshot cloneable
HTML/Node inputs and submit one official task to the installed Workers service. Their options
retain native layout/encoding fields, concrete font bytes and image sources, with
`images.allowRemote` as the cloneable remote-fetch switch. Signal stays on the host and controls
Worker admission/cancellation. Fetch callbacks, font loaders, JSX, Renderer, and WASM modules
do not cross this boundary. Only `css` is accepted for styles.

The task uses execution settlement: cancellation or owner stop waits for confirmed thread exit
before the returned Promise settles. Shared Worker errors retain the Workers contract. A native
task already executing cannot be preempted immediately. No private pool, scheduler, reservation,
provider font policy, configuration or Workbench projection is introduced.

Business JSX tasks import `render`, `renderSvg`, or `renderAnimation` from
`@pluxel/plugin-takumi/worker`, construct their own React elements, and use the same installed Workers
service. Their bundled React, hooks dispatcher and JSX resolver remain together. The worker
adapter accepts local JSX/options and callbacks, but owns Renderer selection and accepts only
concrete font bytes; `renderer`, `module`, and `stylesheets` are unavailable. Importing its
functions into the host does not make them run in a Worker.

The worker implementation statically imports the native core and public helpers. It does not
import the auto-detecting `takumi-js` backend, whose dynamic native load does not match the
self-contained artifact contract. Native residual ownership belongs to this package.

## Resource cache ownership

The native entry points use upstream managed Renderer reuse. The Worker adapter uses a
versioned `Symbol.for` registry on the Worker global, keyed first by the actual native Renderer
constructor and then by ordered font content and metadata. This lets separately bundled tasks
share compatible native resources without sharing React, Context, callbacks, templates, or
Plugin generations. Different font sets use different Renderers to avoid same-family pollution.

The font-set LRU bounds retained Renderer count and source font bytes; each Renderer has a
separate image/SVG/stylesheet resource budget. Oversized font sets render in a temporary
Renderer. The authoritative constants and cache keys live in [renderer-cache.ts](src/renderer-cache.ts).
Source-byte ceilings do not bound decompressed font memory, active render allocations, or
encoded output. The upstream native glyph cache belongs to the loaded binary and can be shared
by threads in the same process.

Cache lifetime is the surviving Worker thread. Idle retirement, running-task cancellation and
Host shutdown discard it. The shared pool does not promise task affinity or one cache for the
whole host. Plugin stop cancels that owner's work; it does not clear another owner's warm
resources. Decoded-image reuse does not imply HTTP-byte or final-output caching.

Verification covers the dependency facade, native JSX/hooks/Context and errors, the official
HTML/Node task, real JSX templates, separately bundled cache reuse, font-set separation,
capacity, cancellation and worker replacement. Public usage belongs to the
[Takumi guide](../../../docs/plugins/rendering/takumi.md).

Run `vp run @pluxel/plugin-takumi#bench:event-loop` after building this package to compare native
and shared-Worker SVG rendering with timer-gap measurements. The probe uses the packaged Node
artifact through a real Host. It reports one machine's warm timings, not a throughput or latency
guarantee; Worker transport and native libuv work remain part of the measurement.
