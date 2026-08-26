# @pluxel/echarts

`@pluxel/echarts` uses Apache ECharts 6 and `@pluxel/canvas` to render charts on the server. All
renders run through Pluxel's root-owned shared worker pool, so layout, text measurement, ZRender flush
and native encoding do not occupy the main event loop. The host still performs a cooperative option-budget
walk and bounded worker transport serialization. Canvas owns resource limits; Fonts supplies the
managed registry, provider-wide default family, and Fonts Selection Port.

```ts
import { EChartsPlugin } from '@pluxel/echarts'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	constructor(private readonly charts: EChartsPlugin) {
		super()
	}

	async renderSales(): Promise<Buffer> {
		const result = await this.charts.render({
			width: 1200,
			height: 630,
			option: {
				xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed'] },
				yAxis: { type: 'value' },
				series: [{ type: 'bar', data: [120, 200, 150] }],
			},
		})
		return result.data
	}
}
```

The host catalog contains `[FontsPlugin, CanvasPlugin, EChartsPlugin, ReportsPlugin]`. `render()` is
worker-only and uses the host-wide `ctx.workers` thread/queue budget. The worker
reconstructs the bounded `@pluxel/canvas/worker` adapter from `canvas.workerSnapshot`, initializes
ECharts in SSR mode, waits for tracked images, flushes, encodes, and disposes the instance in
`finally`. It then closes the caller-owned Canvas adapter, which cancels queued image work and waits
already-submitted native decodes before the handler releases its Worker. ECharts does not initialize
another CanvasPlugin or directly depend on the native binding.
The option graph is borrowed without mutation until the render settles. Bytes/value/depth budgets
run only after shared fair admission, so queue rejection does not first walk the graph; they bound
dispatch serialization, including cooperative chunks for one large string, and the worker rewrites only its private transport clone. PNG
is the default; JPEG/WebP and DPR are explicit options.

## Themes and fonts

```ts
const theme = this.charts.registerTheme({
	name: 'reports',
	theme: {
		color: ['#2563eb', '#16a34a'],
		backgroundColor: '#ffffff',
	},
})

await this.charts.render({ width: 800, height: 400, option, theme: theme.name })
theme.dispose() // optional; caller stop also removes it
```

Named themes are JSON values stored in a caller-owned Pluxel registry. They are deliberately not
written to ECharts' process-global `registerTheme()` table, which has no unregister API. Different
callers may reuse the same local name, and caller stop/replacement deactivates its registrations.
Inline theme objects and ECharts' built-in `default`/`dark` names are also accepted. Theme bytes,
value count and nesting depth are bounded before the JSON snapshot is retained. Named registrations
also share provider-wide retained count/byte ceilings; dispose and caller stop return that capacity.

When neither the option nor theme explicitly supplies `textStyle.fontFamily`, each render injects
the current `FontsPlugin.defaultFont.cssFamily`. Therefore Fonts Workbench changes affect subsequent
renders without rewriting registered themes. The ECharts plugin detail mounts a selector-only Fonts
Port supplied by FontsPlugin; the canonical FontsPlugin page alone uploads and removes fonts. The
single managed collection remains server-process-only and survives Canvas/ECharts consumer stops.

## Images and outbound policy

Data URL image strings in plain `image` fields and `image://data:` values are replaced with short
render-local keys before they reach ZRender, decoded through the Canvas worker adapter, and subject
to per-source bytes, distinct-source count, aggregate source bytes, aggregate decoded pixels, and Canvas
byte/dimension budgets. The trusted placeholder is decoded in place once; a source is not decoded into a
temporary Image and then decoded again through `src`. Ordinary text beginning with `data:` is left untouched.
A render-local failure aborts the other image tasks and suppresses late callbacks. Canvas worker decode
admission defaults to one per adapter, while the Runtime worker pool supplies outer parallelism; the two
limits are local admission rather than ownership of the process-wide libuv pool.
A native Image, formatter function, accessor, class instance or shared mutable buffer cannot cross the
declarative worker boundary and is rejected without an inline fallback.

Encoded raster bytes are checked against `maxOutputBytes` inside the worker before result transport;
the ceiling limits returned data but cannot undo encoder work already completed.

HTTP(S) URLs and server file paths are rejected. Fetch bytes first through an outbound HTTP
capability, enforce its download budget, and encode a bounded data URL for the declarative option.
Native Canvas/Image objects cannot cross this worker-only boundary. This keeps redirect, authentication,
proxy, retry, origin, and cancellation policy outside a drawing library.

See [`DESIGN.md`](DESIGN.md) for global-state and concurrency invariants and
[`docs/plugins/rendering/echarts.md`](../../../docs/plugins/rendering/echarts.md) for the full author path.
