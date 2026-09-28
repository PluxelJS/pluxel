import { Result, TaggedError } from '@pluxel/core/better-result'
import {
	EChartsError,
	type EChartsPlugin,
	type EChartsRenderInput,
	type EChartsRenderResult,
} from '../../src/index.ts'

export class ChartBusy extends TaggedError('ChartBusy')<{ message: string }> {}

export async function renderChart(
	charts: EChartsPlugin,
	input: EChartsRenderInput,
): Promise<Result<EChartsRenderResult, ChartBusy>> {
	try {
		return Result.ok(await charts.render(input))
	} catch (error) {
		if (error instanceof EChartsError && error.code === 'RENDER_BUSY') {
			return Result.err(new ChartBusy({ message: 'Chart renderer is busy; retry later.' }))
		}
		throw error
	}
}
