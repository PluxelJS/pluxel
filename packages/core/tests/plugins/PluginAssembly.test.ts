import { expect, it } from 'vitest'
import * as v from 'valibot'
import { BasePlugin, definePluginRef, Plugin, PluginPart, type Context } from '@pluxel/core'
import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
import { createCoreTestHost } from '@pluxel/core/internal/test'
import { validateConfigRecord } from '../../src/services/config/ops'

export abstract class Counter extends BasePlugin {
	abstract subscribe(): () => void
	abstract next(): readonly [source: string, value: number]
}

const CounterConfig = v.object({ source: v.string() })

@Plugin(Counter, { forkable: true })
export class CounterStore extends Counter {
	private readonly config = this.configs.use(CounterConfig)
	private readonly counters = new Map<Context, number>()
	private ready = false
	get subscribers() {
		return this.counters.size
	}

	protected override init() {
		this.ready = true
		return () => {
			this.ready = false
		}
	}

	override subscribe() {
		const caller = this.ctx.caller
		if (!this.ready || !caller) throw new Error('A running caller needs a ready counter')
		const counters = this.counters
		counters.set(caller, 0)
		return () => {
			counters.delete(caller)
		}
	}

	override next(): readonly [string, number] {
		const caller = this.ctx.caller
		if (!caller) throw new Error('Missing caller')
		const current = this.counters.get(caller)
		if (current === undefined) throw new Error('Counter is not subscribed')
		const value = current + 1
		this.counters.set(caller, value)
		return [this.config.source, value]
	}
}

const DashboardConfig = v.object({ region: v.string() })
const TileConfig = v.object({ metric: v.string() })

class CounterTile extends PluginPart<CounterPanel> {
	private readonly config = this.configs.use(TileConfig)

	constructor(private readonly counter: Counter) {
		super()
	}

	protected override init() {
		return this.counter.subscribe()
	}

	read() {
		const [source, value] = this.counter.next()
		return { title: `${this.host.region} ${this.config.metric}`, source, value }
	}
}

class CounterPanel extends PluginPart<Dashboard> {
	private readonly orders = this.parts.use(CounterTile)
	private readonly refunds = this.parts.use(CounterTile)

	get region() {
		return this.host.region
	}

	read() {
		return [this.orders.read(), this.refunds.read()]
	}
}

@Plugin({ forkable: true })
export class Dashboard extends BasePlugin {
	private readonly config = this.configs.use(DashboardConfig)
	private readonly panel = this.parts.use(CounterPanel)

	get region() {
		return this.config.region
	}

	read() {
		return this.panel.read()
	}
}

function dashboardConfig(region: string) {
	return { region, panel: { orders: { metric: 'orders' }, refunds: { metric: 'refunds' } } }
}

it('assembles scoped Part counters and reroutes only the selected dashboard fork', async () => {
	await using host = createCoreTestHost()
	const east = Dashboard.nodeAddress('east')
	const west = Dashboard.nodeAddress('west')
	const primary = CounterStore.nodeAddress()
	const backup = CounterStore.nodeAddress('backup')
	await host.commit((change) => {
		change.add(primary, { initialConfig: { source: 'primary' } })
		change.add(backup, { initialConfig: { source: 'backup' } })
		change.dependencies.setDefault({ requirement: Counter, provider: CounterStore })
		change.add(east, { initialConfig: dashboardConfig('East') })
		return change.add(west, { initialConfig: dashboardConfig('West') })
	})
	const oldEast = host.require(east)
	const currentWest = host.require(west)
	expect(host.require(primary).subscribers).toBe(4)
	expect(oldEast.read()).toEqual([
		{ title: 'East orders', source: 'primary', value: 1 },
		{ title: 'East refunds', source: 'primary', value: 1 },
	])
	expect(currentWest.read()).toEqual([
		{ title: 'West orders', source: 'primary', value: 1 },
		{ title: 'West refunds', source: 'primary', value: 1 },
	])

	await host.commit((change) =>
		change.dependencies.setOverride({ consumer: east, requirement: Counter, provider: backup }),
	)
	expect(host.require(primary).subscribers).toBe(2)
	expect(host.require(backup).subscribers).toBe(2)
	expect(() => oldEast.read()).toThrow(/stopped|withdrawn/i)
	const updatedEast = host.require(east)
	expect(updatedEast.read()).toEqual([
		{ title: 'East orders', source: 'backup', value: 1 },
		{ title: 'East refunds', source: 'backup', value: 1 },
	])
	const unchangedWest = host.require(west)
	expect(unchangedWest.read()).toEqual([
		{ title: 'West orders', source: 'primary', value: 2 },
		{ title: 'West refunds', source: 'primary', value: 2 },
	])
})

it.each([
	{ patch: { region: 42 }, path: ['region'] },
	{
		patch: { panel: { orders: { metric: 42 }, refunds: { metric: 'refunds' } } },
		path: ['panel', 'orders', 'metric'],
	},
])(
	'keeps the exact error path $path when validating the assembled dashboard',
	async ({ patch, path }) => {
		const { config } = consumePluginDefinitionCandidate(Dashboard).declaration
		await expect(
			validateConfigRecord(config!.schema, { ...dashboardConfig('East'), ...patch }),
		).resolves.toMatchObject({
			ok: false,
			errors: { _root: { [path[0]!]: [expect.objectContaining({ path })] } },
		})
	},
)

it('refuses Part construction without an owning generation', () => {
	expect(() => Reflect.construct(CounterTile, [])).toThrow(/can only be constructed by Core/)
})

const DefaultCounter = definePluginRef<Counter>()

@Plugin()
export class OptionalCounterClient extends BasePlugin {
	connected = false

	protected override init() {
		this.plugins.use(DefaultCounter, () => {
			this.connected = true
		})
	}
}

it('only binds an abstract default for required dependency requests', async () => {
	await using host = createCoreTestHost()
	const client = OptionalCounterClient.nodeAddress()
	await host.commit((change) => {
		change.add(CounterStore.nodeAddress(), { initialConfig: { source: 'primary' } })
		change.dependencies.setDefault({ requirement: Counter, provider: CounterStore })
		return change.add(client)
	})
	const observer = host.require(client)
	expect(observer.connected).toBe(false)
})
