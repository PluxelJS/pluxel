// Read this when you need a separately-built Node module consumed by Tinypool.

import { BasePlugin, defineNodeModule, Plugin } from '@pluxel/runtime'
import { workbench, workbenchDoc } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { Tinypool } from 'tinypool'

type WorkerStatus = {
	enabled: boolean
	mode: 'node-module'
	workerUrl: string | null
	note: string
}

type SquareResult = {
	input: number
	squared: number
	mode: WorkerStatus['mode']
}

const squareWorker = defineNodeModule(import.meta.url, './PluginHttpWorkerDemo/ui/worker.ts')
const d = workbenchDoc({} as const)
const HttpWorkerUi = workbenchContract.define({
	views: {
		documentation: workbenchContract.document({
			placements: [workbenchContract.tab({ label: 'Worker Demo' })],
			title: 'HTTP Worker Demo',
			content: d`
					Route base: \`/__pluxel/plugins/PluginHttpWorkerDemo/worker-demo\`.

					- \`GET /status\`: reports the active Node module artifact.
					- \`GET /square/:value\`: invokes the artifact through Tinypool.

					Development rebuilds and packaged/static artifacts use the same declaration and lifecycle.
				`,
		}),
	},
})
const HttpWorkerWorkbench = workbench.extension({ contract: HttpWorkerUi })

@Plugin({ name: 'PluginHttpWorkerDemo' })
export class PluginHttpWorkerDemo extends BasePlugin {
	private pool: Tinypool | null = null
	private workerUrl: URL | null = null

	override async init(): Promise<void> {
		this.ctx.http.plugin.routes(
			(app) =>
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
			{
				path: '/worker-demo',
				id: 'PluginHttpWorkerDemo:http',
			},
		)

		this.ctx.workbench.mount(HttpWorkerWorkbench, {})

		await this.ctx.nodeModules.use(squareWorker, async (url) => {
			const pool = new Tinypool({
				filename: url.href,
				minThreads: 1,
				maxThreads: 1,
				idleTimeout: 10_000,
			})
			this.pool = pool
			this.workerUrl = url
			return async () => {
				if (this.pool === pool) this.pool = null
				if (this.workerUrl === url) this.workerUrl = null
				await pool.destroy()
			}
		})
	}

	// Public route behavior.
	private async getWorkerStatus(): Promise<WorkerStatus> {
		return {
			enabled: this.pool !== null,
			mode: 'node-module',
			workerUrl: this.workerUrl?.href ?? null,
			note: 'The Node module artifact is managed by the plugin Context lifecycle.',
		}
	}

	private async square(value: number): Promise<SquareResult> {
		const pool = this.pool
		if (!pool) throw new Error('Node module consumer is not ready')

		const result = (await pool.run({ value })) as { squared: number }
		return {
			input: value,
			squared: result.squared,
			mode: 'node-module',
		}
	}
}
