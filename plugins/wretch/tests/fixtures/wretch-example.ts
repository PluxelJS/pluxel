import { BasePlugin, f, Plugin, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { Wretch } from 'wretch'
import { retry } from 'wretch/middlewares'
import { WretchPlugin } from '../../src/index.ts'
import { WretchWorkbenchPort } from '../../src/workbench-contract.ts'

const WretchExampleConfig = v.object({
	baseUrl: v.pipe(
		v.optional(v.pipe(v.string(), v.url()), 'https://httpbingo.org'),
		f.formMeta({ label: '示例上游', description: 'WretchExamplePlugin 调用的 HTTP API base URL' }),
		f.stringMeta({ placeholder: 'https://httpbingo.org' }),
	),
	inspectPath: v.pipe(
		v.optional(v.pipe(v.string(), v.startsWith('/')), '/get'),
		f.formMeta({ label: '检查路径', description: '必须是以 / 开头的相对 API 路径' }),
		f.stringMeta({ placeholder: '/get' }),
	),
	retryAttempts: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)), 1),
		f.formMeta({
			label: 'GET 重试次数',
			description: '0 表示关闭；使用 Wretch 原生 retry middleware',
		}),
		f.numberMeta({ min: 0, max: 5, step: 1, integer: true }),
	),
})

const WretchExampleWorkbench = workbench.portOutlet({
	id: 'Http',
	port: WretchWorkbenchPort,
	placement: workbenchContract.tab({
		label: 'HTTP',
		icon: workbenchContract.icons.Settings,
	}),
})

@Plugin({ displayName: 'WretchExamplePlugin' })
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

		this.ctx.http.plugin.routes((app) => app.get('/inspect', () => this.inspect()), {
			publicPath: '/wretch-example',
			id: 'wretch-example',
		})
		this.ctx.workbench.mount(WretchExampleWorkbench, {
			settings: workbench.bind.rpc(() => this.http.workbenchSettings()),
		})
	}

	inspect<T = unknown>(): Promise<T> {
		return this.api.get(this.config.inspectPath).json<T>()
	}
}
