# @pluxel/echarts

`@pluxel/echarts` uses Apache ECharts 6 and `@pluxel/canvas` to render charts on the server. Normal
renders run through Pluxel's root-owned shared worker pool, so layout, text measurement, ZRender flush
and native encoding do not block the main event loop. Canvas owns resource limits; Fonts supplies the
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

The host catalog contains `[FontsPlugin, CanvasPlugin, EChartsPlugin, ReportsPlugin]`. `render()`
defaults to `execution: 'worker'` and uses the host-wide `ctx.workers` thread/queue budget. The worker
reconstructs the bounded `@pluxel/canvas/worker` adapter from `canvas.workerSnapshot`, initializes
ECharts in SSR mode, waits for tracked images, flushes, encodes, and disposes the instance in
`finally`. ECharts does not initialize another CanvasPlugin or directly depend on the native binding.
The worker rewrites only its private structured-cloned option graph; caller input is unchanged. PNG
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
Inline theme objects and ECharts' built-in `default`/`dark` names are also accepted.

When neither the option nor theme explicitly supplies `textStyle.fontFamily`, each render injects
the current `FontsPlugin.defaultFont.cssFamily`. Therefore Fonts Workbench changes affect subsequent
renders without rewriting registered themes. The ECharts plugin detail mounts a selector-only Fonts
Port supplied by FontsPlugin; the canonical FontsPlugin page alone uploads and removes fonts. The
single managed collection remains server-process-only and survives Canvas/ECharts consumer stops.

## Images and outbound policy

Data URL image strings in plain `image` fields and `image://data:` values are replaced with short
render-local keys before they reach ZRender, decoded through the Canvas worker adapter, and subject
to both ECharts and Canvas byte/dimension budgets. Ordinary text beginning with `data:` is left untouched.
A native Image or formatter function cannot cross the structured-clone worker boundary. Callers that
need those ECharts escape hatches must explicitly set `execution: 'inline'`; this compatibility mode
can block the event loop and still uses CanvasPlugin budgets.

HTTP(S) URLs and server file paths are rejected. Fetch bytes first through an outbound HTTP
capability, call `CanvasPlugin.decodeImage()`, and use that Image in the option. This keeps redirect,
authentication, proxy, retry, origin, and cancellation policy outside a drawing library.

See [`DESIGN.md`](DESIGN.md) for global-state and concurrency invariants and
[`user-docs/echarts.md`](../../user-docs/echarts.md) for the full author path.
