import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { Wretch } from 'wretch'
import { retry } from 'wretch/middlewares'
import { WretchPlugin } from '../index.ts'
import { WretchWorkbenchPort } from '../workbench-contract.ts'
import { WretchExampleConfig } from './config.ts'

const WretchExampleWorkbench = workbench.portOutlet({
	id: 'Http',
	port: WretchWorkbenchPort,
	placement: workbenchContract.slot(workbenchContract.slots.PluginTabs, {
		label: 'HTTP',
		icon: workbenchContract.icons.Settings,
	}),
})

@Plugin({ name: 'WretchExamplePlugin' })
export class WretchExamplePlugin extends BasePlugin {
	private readonly config = this.configs.use(WretchExampleConfig)
	private api!: Wretch

	constructor(private readonly http: WretchPlugin) {
		super()
	}

	override async init(): Promise<void> {
		await this.http.enableManagedSettings()
		let api = this.http.client
			.url(this.config.baseUrl, true)
			.accept('application/json')
			.headers({ 'X-Pluxel-Client': 'WretchExamplePlugin' })

		if (this.config.retryAttempts > 0) {
			api = api.middlewares([
				retry({
					maxAttempts: this.config.retryAttempts,
					retryOnNetworkError: true,
				}),
			])
		}
		this.api = api

		this.ctx.http.plugin.routes((app) => app.get('/inspect', () => this.inspect()))
		this.ctx.workbench.mount(WretchExampleWorkbench, {
			settings: workbench.bind.rpc(() => this.http.workbenchSettings()),
		})
	}

	/** A small real capability used by tests and static-runtime demos. */
	inspect<T = unknown>(): Promise<T> {
		return this.api.get(this.config.inspectPath).json<T>()
	}
}

export { WretchExampleConfig, type WretchExampleConfigValue } from './config.ts'
