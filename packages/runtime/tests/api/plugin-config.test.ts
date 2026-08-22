import {
	getPluginConfigDefinition,
	getPluginInfo,
	pluginNodeAddressOf,
	type PluginConstructor,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	BasePlugin,
	createRuntimeHost,
	ForkablePlugin,
	Plugin,
	type RuntimeHost,
} from '@pluxel/runtime/test'
import { afterEach, describe, expect, it } from 'vitest'
import { v } from '../../src/config'
import { pluginConfigPatch } from '../../src/api/usecases/pluginConfig'
import {
	createMemoryPersistenceBackend,
	type PersistenceBackend,
} from '../../src/services/persistence/PersistenceService'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

const ConfigSchema = v.object({
	value: v.optional(v.string(), 'initial'),
})

let defaultStarts: string[] = []
let forkStarts = new Map<string, string[]>()
let failingStarts = 0

@Plugin()
class ConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		defaultStarts.push(this.config.value)
	}
}

@Plugin()
class ConfigFork extends ForkablePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		const address = this.ctx.pluginInfo.nodeAddress
		const key = address.variant === 'fork' ? address.forkId : 'default'
		const values = forkStarts.get(key) ?? []
		values.push(this.config.value)
		forkStarts.set(key, values)
	}
}

@Plugin()
class StoppedConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)
}

@Plugin()
class FailingConfigOwner extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)

	override init() {
		failingStarts++
		if (failingStarts > 1) throw new Error('restart rejected')
	}
}

const hosts: RuntimeHost[] = []

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose()
	defaultStarts = []
	forkStarts = new Map()
	failingStarts = 0
})

describe('Plugin config application scope', () => {
	it('durably saves and restarts one running default node', async () => {
		const host = runtimeHost()
		installTestRoute(host, [ConfigOwner])
		host.add(ConfigOwner)
		host.cfg(ConfigOwner).enable()
		await host.commit()

		const owner = pluginNodeAddressOf(ConfigOwner)
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'changed' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'applied',
			config: { value: 'changed' },
		})
		expect(defaultStarts).toEqual(['initial', 'changed'])
	})

	it('restarts only the addressed fork and keeps sibling config isolated', async () => {
		const host = runtimeHost()
		const East = host.fork(ConfigFork, 'east')
		const West = host.fork(ConfigFork, 'west')
		installTestRoute(host, [East, West])
		host.cfg(East).enable()
		host.cfg(West).enable()
		await host.commit()

		const east = pluginNodeAddressOf(East)
		const west = pluginNodeAddressOf(West)
		await expect(pluginConfigPatch(host.ctx, east, { value: 'east-only' })).resolves.toMatchObject({
			ok: true,
			application: 'applied',
		})

		expect(forkStarts.get('east')).toEqual(['initial', 'east-only'])
		expect(forkStarts.get('west')).toEqual(['initial'])
		expect(host.ctx.configService.getRawConfig(host.ctx.registry.internNodeAddress(east))).toEqual({
			value: 'east-only',
		})
		expect(host.ctx.configService.getRawConfig(host.ctx.registry.internNodeAddress(west))).toEqual({
			value: 'initial',
		})
	})

	it('defers application for a stopped node', async () => {
		const host = runtimeHost()
		installTestRoute(host, [StoppedConfigOwner])
		host.add(StoppedConfigOwner)
		host.cfg(StoppedConfigOwner).enable()

		const owner = pluginNodeAddressOf(StoppedConfigOwner)
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'later' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'deferred',
			config: { value: 'later' },
		})
		expect(host.isRunning(StoppedConfigOwner)).toBe(false)
	})

	it('keeps desired config after a restart failure and reports it as not applied', async () => {
		const host = runtimeHost()
		installTestRoute(host, [FailingConfigOwner])
		host.add(FailingConfigOwner)
		host.cfg(FailingConfigOwner).enable()
		await host.commit()

		const owner = pluginNodeAddressOf(FailingConfigOwner)
		await expect(pluginConfigPatch(host.ctx, owner, { value: 'desired' })).resolves.toMatchObject({
			ok: true,
			saved: true,
			application: 'saved-not-applied',
			config: { value: 'desired' },
		})
		expect(host.ctx.configService.getRawConfig(host.ctx.registry.internNodeAddress(owner))).toEqual(
			{
				value: 'desired',
			},
		)
		expect(host.isRunning(FailingConfigOwner)).toBe(false)
	})
})

describe('ConfigService persistence', () => {
	it('uses atomic writes, surfaces failure, and retries the desired snapshot', async () => {
		const delegate = createMemoryPersistenceBackend()
		const writes: Array<{ namespace: string; key: string; atomic: boolean }> = []
		let rejectConfigWrite = false
		const backend: PersistenceBackend = {
			capability: delegate.capability,
			preflight: delegate.preflight,
			namespace(name) {
				const storage = delegate.namespace(name)
				return {
					...storage,
					async put(key, value, options) {
						writes.push({ namespace: name, key, atomic: options?.atomic === true })
						if (rejectConfigWrite && name === 'config' && key === 'config.json') {
							throw new Error('config storage unavailable')
						}
						await storage.put(key, value, options)
					},
				}
			},
		}
		const host = runtimeHost({
			persistence: { mode: 'custom', backend },
			configService: { mode: 'file' },
		})
		await host.ctx.configService.ready
		writes.length = 0

		@Plugin()
		class PersistedConfigOwner extends BasePlugin {}

		lowerTestPlugin(PersistedConfigOwner)
		const slot = host.ctx.registry.internNodeAddress(pluginNodeAddressOf(PersistedConfigOwner))
		host.ctx.configService.patchConfig(slot, { value: 'desired' })
		rejectConfigWrite = true

		await expect(host.ctx.configService.flush()).rejects.toThrow('config storage unavailable')
		expect(writes).toEqual([{ namespace: 'config', key: 'config.json', atomic: true }])

		rejectConfigWrite = false
		await host.ctx.configService.flush()
		expect(writes.at(-1)).toEqual({
			namespace: 'config',
			key: 'config.json',
			atomic: true,
		})
	})
})

function runtimeHost(config: Parameters<typeof createRuntimeHost>[0] = {}): RuntimeHost {
	const host = createRuntimeHost({ workbench: false, ...config })
	hosts.push(host)
	return host
}

function installTestRoute(host: RuntimeHost, constructors: readonly PluginConstructor[]): void {
	const entries = constructors.map((ctor) => {
		const info = getPluginInfo(ctor)
		return {
			address: pluginNodeAddressOf(ctor),
			ctor,
			displayName: info.displayName,
			rootExportName: info.rootExportName,
		}
	})
	const key = (address: PluginNodeAddress) => JSON.stringify(address)
	const definitionKey = (address: PluginDefinitionAddress) => JSON.stringify(address)
	const byNode = new Map(entries.map((entry) => [key(entry.address), entry]))
	const byDefinition = new Map(
		entries.map((entry) => [definitionKey(entry.address.definition), entry]),
	)
	host.ctx.runtimeRoute = {
		catalog: {
			resolve: (address) => byNode.get(key(address))?.ctor,
			resolveDefinition: (address) => byDefinition.get(definitionKey(address))?.ctor,
			require(address) {
				const plugin = byNode.get(key(address))?.ctor
				if (!plugin) throw new Error('Plugin node not found')
				return plugin
			},
			listRegistered: () => entries,
		},
		lifecycle: {
			isRunning(address) {
				const plugin = byNode.get(key(address))?.ctor
				return plugin ? host.isRunning(plugin) : false
			},
			enable(_address, plugin) {
				if (!host.has(plugin)) host.add(plugin)
				host.cfg(plugin).enable()
			},
			enablePersisted(address) {
				const plugin = byNode.get(key(address))?.ctor
				if (!plugin) throw new Error('Plugin node not found')
				if (!host.has(plugin)) host.add(plugin)
				host.cfg(plugin).enable()
			},
			deactivate(_address, plugin, { runtimeOnly }) {
				if (host.has(plugin)) host.remove(plugin)
				if (!runtimeOnly) host.cfg(plugin).disable()
			},
			stop(_address, plugin) {
				if (host.has(plugin)) host.remove(plugin)
			},
		},
		configMetadata: {
			getConfig(address) {
				const plugin = byNode.get(key(address))?.ctor
				return plugin ? getPluginConfigDefinition(plugin) : undefined
			},
		},
	}
}
