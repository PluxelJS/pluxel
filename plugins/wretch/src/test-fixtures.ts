import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import type { FetchLike, Wretch } from 'wretch'
import { WretchPlugin } from './index.ts'
import { WretchWorkbench } from './workbench.ts'

let fetchA: FetchLike
let fetchB: FetchLike

export function setFixtureFetches(a: FetchLike, b: FetchLike = a): void {
	fetchA = a
	fetchB = b
}

const ConsumerWorkbench = workbench.define({
	settings: WretchWorkbench.settings.place(
		workbench.tab({ label: 'HTTP', icon: workbench.icons.Settings }),
	),
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
		this.ctx.workbench?.publish(ConsumerWorkbench, {
			settings: { provider: this.http },
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
		this.ctx.workbench?.publish(ConsumerWorkbench, {
			settings: { provider: this.http },
		})
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
		this.ctx.workbench?.publish(ConsumerWorkbench, {
			settings: { provider: this.http },
		})
	}
}
