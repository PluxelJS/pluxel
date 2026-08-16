import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { FetchLike, Wretch } from 'wretch'
import { WretchPlugin } from './index.ts'
import { WretchWorkbenchPort } from './workbench-contract.ts'

let fetchA: FetchLike
let fetchB: FetchLike

export function setFixtureFetches(a: FetchLike, b: FetchLike = a): void {
	fetchA = a
	fetchB = b
}

const ConsumerWorkbench = workbench.portOutlet({
	id: 'Http',
	port: WretchWorkbenchPort,
	placement: workbenchContract.tab({
		label: 'HTTP',
		icon: workbenchContract.icons.Settings,
	}),
})

@Plugin({ displayName: 'WretchConsumer' })
export class ConsumerA extends BasePlugin {
	private readonly testConfig = this.configs.use(v.object({}))
	client!: Wretch

	constructor(readonly http: WretchPlugin) {
		super()
	}

	override async init(): Promise<void> {
		void this.testConfig
		await this.http.enableManagedSettings()
		this.client = this.http.client
			.url('https://a.example/api', true)
			.headers({ Authorization: 'Bearer secret-a', 'X-Consumer': 'a' })
			.fetchPolyfill(fetchA)
		this.ctx.workbench.mount(ConsumerWorkbench, {
			settings: workbench.bind.rpc(() => this.http.workbenchSettings()),
		})
	}
}

@Plugin({ displayName: 'WretchConsumer' })
export class ConsumerLateSettings extends BasePlugin {
	client!: Wretch

	constructor(readonly http: WretchPlugin) {
		super()
	}

	override async init(): Promise<void> {
		this.client = this.http.client.url('https://late.example/api', true).fetchPolyfill(fetchA)
		await this.http.enableManagedSettings()
	}
}

@Plugin({ displayName: 'WretchConsumerB' })
export class ConsumerB extends BasePlugin {
	private readonly testConfig = this.configs.use(v.object({}))
	client!: Wretch

	constructor(readonly http: WretchPlugin) {
		super()
	}

	override init(): void {
		void this.testConfig
		this.client = this.http.client
			.url('https://b.example/v1', true)
			.headers({ 'X-Consumer': 'b' })
			.fetchPolyfill(fetchB)
	}
}
