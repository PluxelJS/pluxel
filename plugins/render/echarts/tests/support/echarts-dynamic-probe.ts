import { CanvasPlugin } from '@pluxel/canvas'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { EChartsError, EChartsPlugin, type EChartsOption } from '../../src/index.ts'

const barOption = {
	title: { text: 'Pluxel' },
	xAxis: { type: 'category', data: ['A', 'B', 'C'] },
	yAxis: { type: 'value' },
	series: [{ type: 'bar', data: [3, 7, 5] }],
} satisfies EChartsOption

/** Test-only dynamic fixture. It stays outside package source and is never exported by the Plugin. */
@Plugin()
export class EChartsDynamicProbePlugin extends BasePlugin {
	constructor(
		private readonly echarts: EChartsPlugin,
		private readonly canvas: CanvasPlugin,
	) {
		super()
	}

	protected override init(): void {
		this.ctx.elysia
			.get('/__pluxel-test/echarts/render', () => this.render())
			.get('/__pluxel-test/echarts/error/remote-image', () =>
				this.errorCode({
					graphic: {
						elements: [
							{
								type: 'image',
								left: 0,
								top: 0,
								style: {
									image: 'https://example.invalid/private.png',
									width: 4,
									height: 4,
								},
							},
						],
					},
				}),
			)
			.get('/__pluxel-test/echarts/error/formatter', () =>
				this.errorCode({
					...barOption,
					tooltip: { formatter: () => 'inline' },
				}),
			)
	}

	private async render(): Promise<Response> {
		const source = this.canvas.createCanvasSync(4, 4)
		source.getContext('2d').fillRect(0, 0, 4, 4)
		const sourceBytes = await source.encode('png')
		const dataUrl = `data:image/png;base64,${sourceBytes.toString('base64')}`
		const svgDataUrl = `data:image/svg+xml,${encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#2563eb"/></svg>',
		)}`
		const imageOption = (image: string): EChartsOption => ({
			graphic: {
				elements: [{ type: 'image', left: 0, top: 0, style: { image, width: 4, height: 4 } }],
			},
		})
		const rasterOption = imageOption(dataUrl)
		const vectorOption = imageOption(svgDataUrl)
		const rasterBefore = JSON.stringify(rasterOption)
		const vectorBefore = JSON.stringify(vectorOption)
		const [raster, vector] = await Promise.all([
			this.echarts.render({ width: 32, height: 32, option: rasterOption }),
			this.echarts.render({ width: 48, height: 24, option: vectorOption }),
		])
		if (
			JSON.stringify(rasterOption) !== rasterBefore ||
			JSON.stringify(vectorOption) !== vectorBefore
		) {
			throw new Error('ECharts worker transport mutated the caller-owned option graph')
		}
		if (vector.mediaType !== 'image/png') {
			throw new Error(`Unexpected vector render media type: ${vector.mediaType}`)
		}
		return new Response(Uint8Array.from(raster.data).buffer, {
			headers: { 'content-type': raster.mediaType },
		})
	}

	private async errorCode(option: EChartsOption): Promise<Response> {
		try {
			await this.echarts.render({ width: 32, height: 32, option })
			return Response.json({ code: 'UNEXPECTED_SUCCESS' }, { status: 500 })
		} catch (error) {
			return Response.json({
				code: error instanceof EChartsError ? error.code : 'UNEXPECTED_ERROR',
			})
		}
	}
}
