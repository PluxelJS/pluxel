import {
	CanvasError,
	createCanvasWorkerAdapter,
	type CanvasWorkerAdapter,
	type CanvasWorkerSnapshot,
} from '@pluxel/canvas/worker'
import { EChartsError, type EChartsErrorCode } from './errors.ts'
import {
	renderECharts,
	type RenderCanvasAdapter,
	type RenderEngineInput,
	type RenderEngineResult,
} from './render-engine.ts'

export type EChartsWorkerInput = Readonly<{
	render: RenderEngineInput
	canvas: CanvasWorkerSnapshot
}>

export type EChartsWorkerOutput =
	| Readonly<{ ok: true; result: RenderEngineResult }>
	| Readonly<{
			ok: false
			error: Readonly<{ code: EChartsErrorCode; message: string }>
	  }>

const workerSignal = new AbortController().signal

type CanvasWorkerAdapterFactory = (snapshot: CanvasWorkerSnapshot) => CanvasWorkerAdapter

export function createEChartsWorkerHandler(
	createAdapter: CanvasWorkerAdapterFactory = createCanvasWorkerAdapter,
): (input: EChartsWorkerInput) => Promise<EChartsWorkerOutput> {
	return async (input) => {
		let canvas: CanvasWorkerAdapter | undefined
		try {
			canvas = createAdapter(input.canvas)
			const result = await renderECharts(
				input.render,
				canvas as unknown as RenderCanvasAdapter,
				workerSignal,
			)
			return { ok: true, result }
		} catch (cause) {
			const error =
				cause instanceof EChartsError
					? cause
					: cause instanceof CanvasError
						? new EChartsError('RENDER_FAILED', cause.message, { cause })
						: new EChartsError('RENDER_FAILED', 'Apache ECharts worker rendering failed', {
								cause,
							})
			return { ok: false, error: { code: error.code, message: error.message } }
		} finally {
			await canvas?.close()
		}
	}
}

const handler = createEChartsWorkerHandler()

export default handler
