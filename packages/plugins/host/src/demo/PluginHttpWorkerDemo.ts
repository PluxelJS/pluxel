import { BasePlugin, Plugin } from '@pluxel/runtime'
import { worker, type HmrWorkerBinding } from '@pluxel/hmr/plugin'
import { doc } from '@pluxel/runtime/services'
import Tinypool from 'tinypool'

type WorkerStatus = {
	enabled: boolean
	mode: 'hmr-worker' | 'fallback-inline'
	workerUrl: string | null
	note: string
}

type SquareResult = {
	input: number
	squared: number
	mode: WorkerStatus['mode']
}

const squareWorker = worker('./PluginHttpWorkerDemo/ui/worker.ts')

@Plugin({ name: 'PluginHttpWorkerDemo' })
export class PluginHttpWorkerDemo extends BasePlugin {
	private pool: Tinypool | null = null
	private workerBinding: HmrWorkerBinding | null = null

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

		this.ctx.ext.ui.doc({
			id: 'plugin-http-worker-demo',
			point: 'plugin:tabs',
			title: 'HTTP Worker Demo',
			meta: {
				label: 'Worker Demo',
			},
			content: doc`
				Route base: \`/__pluxel/plugins/PluginHttpWorkerDemo/worker-demo\`.

				Endpoints:
				- \`GET /status\`: reports whether the HMR-only worker bundler is attached.
				- \`GET /square/:value\`: squares a number via Tinypool when HMR is active.

				Frozen/static runtimes intentionally fall back to inline execution.
				If you need a real production worker, prebuild a stable \`.mjs\` entry with tsdown instead of relying on the dev bundler.
			`,
		})

		this.workerBinding = await squareWorker.bind(this.ctx, {
			onError: (error) => {
				this.ctx.logger.error('Failed to rebuild worker bundle', { error })
			},
			onUpdate: async ({ mode, url }) => {
				if (mode !== 'hmr' || !url) {
					await this.disposePool()
					return
				}
				await this.replacePool(url)
			},
		})

		this.ctx.effects.defer(() => this.disposePool())
	}

	private async getWorkerStatus(): Promise<WorkerStatus> {
		const snapshot = this.workerBinding?.snapshot() ?? { mode: 'fallback' as const, url: null }
		const enabled = snapshot.mode === 'hmr'
		return {
			enabled,
			mode: enabled ? 'hmr-worker' : 'fallback-inline',
			workerUrl: snapshot.url,
			note: enabled
				? 'HMR dev bundler is available; worker source is compiled on demand.'
				: 'No dev bundler attached. This is expected for frozen/static runtimes; use tsdown if you need a production worker artifact.',
		}
	}

	private async square(value: number): Promise<SquareResult> {
		const pool = this.pool
		if (!pool) {
			return {
				input: value,
				squared: value * value,
				mode: 'fallback-inline',
			}
		}

		const result = (await pool.run({ value })) as { squared: number }
		return {
			input: value,
			squared: result.squared,
			mode: 'hmr-worker',
		}
	}

	private async replacePool(workerUrl: string): Promise<void> {
		const pool = new Tinypool({
			filename: workerUrl,
			minThreads: 1,
			maxThreads: 1,
			idleTimeout: 10_000,
		})

		await this.disposePool()
		this.pool = pool
	}

	private async disposePool(): Promise<void> {
		const pool = this.pool
		this.pool = null
		if (!pool) return
		await pool.destroy().catch((): undefined => undefined)
	}
}
