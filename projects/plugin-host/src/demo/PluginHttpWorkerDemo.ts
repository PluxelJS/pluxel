// Read this when you need a CPU-bound task on the runtime's shared worker pool.

import { BasePlugin, defineWorkerTask, Plugin } from '@pluxel/runtime'

type WorkerStatus = {
	enabled: boolean
	mode: 'shared-worker'
	note: string
}

type SquareResult = {
	input: number
	squared: number
	mode: WorkerStatus['mode']
}

const squareWorker = defineWorkerTask<{ value: number }, { squared: number }>(
	import.meta.url,
	'./PluginHttpWorkerDemo/ui/worker.ts',
)
@Plugin()
export class PluginHttpWorkerDemo extends BasePlugin {
	override async init(): Promise<void> {
		this.ctx.elysia.group('/demo/worker', (app) =>
			app
				.get('/status', async () => this.getWorkerStatus())
				.get('/square/:value', async ({ params, set }) => {
					const value = Number(params.value)
					if (!Number.isFinite(value)) {
						set.status = 400
						return {
							error: 'value must be a finite number',
						}
					}
					return this.square(value)
				}),
		)
	}

	// Public route behavior.
	private async getWorkerStatus(): Promise<WorkerStatus> {
		return {
			enabled: true,
			mode: 'shared-worker',
			note: 'The runtime root owns lazy threads, queue limits, fairness, and plugin cancellation.',
		}
	}

	private async square(value: number): Promise<SquareResult> {
		const result = await this.ctx.workers.run(squareWorker, { value })
		return {
			input: value,
			squared: result.squared,
			mode: 'shared-worker',
		}
	}
}
