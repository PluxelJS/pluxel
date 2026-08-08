# ECharts plugin design

`@pluxel/echarts` turns Apache ECharts' browser-oriented Canvas integration into a bounded,
caller-aware server capability without making ECharts a runtime special case.

## Required capabilities and render lifecycle

- `CanvasPlugin` and `FontsPlugin` are direct constructor dependencies. Canvas owns native factory,
  decode, dimensions and pixels; Fonts owns managed files, native font keys and default selection.
- `render()` is the resource boundary: validate input, allocate the physical DPR canvas, enter a
  render-local platform scope, initialize ECharts with `ssr: true`, set the option, flush/load/flush,
  encode, then dispose the ECharts instance in `finally`.
- The ECharts instance is not returned. A raw long-lived instance could invoke process-global
  platform callbacks outside its caller scope and would make disposal ownership ambiguous.
- Caller/provider stop aborts image waits. Native image decode and encode cannot be interrupted once
  submitted, so cancellation stops waiting and discards late results rather than claiming to stop
  native work.

## Process-global ECharts state

`setPlatformAPI()` mutates ZRender's process-global singleton and has no restore contract. The
installed callbacks are therefore stable, inert outside `render()`, and resolve Canvas capability
through Node `AsyncLocalStorage`. The versioned storage is kept behind `Symbol.for()` so HMR/module
re-evaluation reuses the same routing scope instead of leaving callbacks bound to an obsolete module
instance. Concurrent renders receive separate Canvas/default-font/image maps; no mutable global
“current render” variable exists.

ECharts' theme table is also global and only supports overwrite, not unregister. `registerTheme()`
on this plugin instead stores a validated, frozen JSON clone under the current caller Context and
passes a theme object directly to `echarts.init()`. The caller lease provides deterministic manual
and lifecycle cleanup even though upstream cannot clean its own registry. Built-in `default` and
`dark` remain available without exposing arbitrary third-party global registrations.

ECharts/ZRender retains an upstream LRU of at most 50 loaded Image objects. Plain option data URLs
are rewritten to short unique keys so encoded source text is not used as a process-global cache key;
the native decoded objects still follow that bounded upstream LRU. Data URL values created later by
arbitrary formatter callbacks cannot be rewritten in advance.

## Font and image semantics

At render time, a default theme gets `FontsPlugin.defaultFont.cssFamily`. Registered/inline themes
with an explicit global family keep it, and option-level text style remains highest priority.
Workbench changes therefore affect future renders; existing prepared options and encoded results do
not mutate. ECharts mounts `FontsSelectionPort` only as a consumer-selected placement: its resource
is a provider-owned candidate/default projection and cannot upload or delete fonts. The canonical
manager View and managed collection remain owned by FontsPlugin.

Only data URL strings are accepted by the platform loader. The option walker rewrites `image://data:`
values and plain `image` fields, clones arrays and plain records, preserves functions/typed arrays/native
Canvas objects by identity, deduplicates equal image sources inside one render, and sends decoded bytes
through `CanvasPlugin.decodeImage()`. Ordinary label/data text beginning with `data:` remains text.
Network and file loading remain caller-owned I/O.

## Why core/runtime is unchanged

Required dependencies, Context-bound views, effects, AbortSignal, config and typed Workbench Ports
already express the needed ownership. The reusable lesson is documented in the plugin author model:
irreversible third-party globals should contain stable routing callbacks or immutable implementation
facts, while caller registrations and mutable state remain in Context-owned registries. ECharts does
not justify a runtime-specific hook.
