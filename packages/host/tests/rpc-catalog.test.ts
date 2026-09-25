import { BasePlugin, Plugin } from '@pluxel/core'
import {
	__setPluginDefinition,
	__setPluginRpcSites,
	PLUGIN_LOWERING_ABI_VERSION,
} from '@pluxel/core/toolchain'
import { expect, it } from 'vitest'
import { createHost, defineHostService, type PluginSourceOpenOptions } from '../src/index'
import { installHostRpcCatalogRegistrar, type HostRpcCatalogEntry } from '../src/internal'

const definition = {
	entry: { kind: 'package-root', packageName: '@test/rpc-catalog' },
	exportName: 'RpcPlugin',
} as const
const address = { definition, variant: 'default' as const }

function builtPlugin(
	label: string,
	bindingsByArtifact: ReadonlyMap<object, Readonly<Record<string, unknown>>>,
	events: string[],
) {
	const artifact = Object.freeze({ label })
	const bindings = Object.freeze({ read: Object.freeze({ label }) })
	@Plugin()
	class RpcPlugin extends BasePlugin {
		init() {
			events.push(`${label}:init:${bindingsByArtifact.get(artifact) === bindings}`)
			this.ctx.effects.defer(() => {
				events.push(`${label}:stop:${bindingsByArtifact.get(artifact) === bindings}`)
			})
		}
	}
	__setPluginDefinition(RpcPlugin, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition,
	})
	__setPluginRpcSites(RpcPlugin, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		sites: Object.freeze([
			Object.freeze({ site: `${label}.read`, owner: 'RpcPlugin', artifact, bindings }),
		]),
	})
	return { plugin: RpcPlugin, artifact, bindings }
}

function rpcProbe() {
	const bindingsByArtifact = new Map<object, Readonly<Record<string, unknown>>>()
	const rejectedBindings = new Set<Readonly<Record<string, unknown>>>()
	const service = defineHostService({
		name: 'rpc-probe',
		capabilities: [],
		prepare({ ctx, effects }) {
			installHostRpcCatalogRegistrar(ctx, {
				prepare(entries: readonly HostRpcCatalogEntry[]) {
					const sites = entries.flatMap((entry) => entry.sites)
					if (sites.some((site) => rejectedBindings.has(site.bindings)))
						throw new Error('rejected RPC facts')
					const next = new Map(sites.map((site) => [site.artifact, site.bindings] as const))
					return () => {
						bindingsByArtifact.clear()
						for (const [artifact, bindings] of next) bindingsByArtifact.set(artifact, bindings)
					}
				},
			})
			effects.defer(() => bindingsByArtifact.clear(), { phase: 'shutdown' })
		},
	})
	return { bindingsByArtifact, rejectedBindings, service }
}

it('publishes fixed RPC facts before init, replaces them after teardown, and retains them on rejection', async () => {
	const events: string[] = []
	const probe = rpcProbe()
	const visible = probe.bindingsByArtifact
	const original = builtPlugin('original', visible, events)
	const replacement = builtPlugin('replacement', visible, events)
	const rejected = builtPlugin('rejected', visible, events)
	probe.rejectedBindings.add(rejected.bindings)
	const host = await createHost({
		plugins: [original.plugin],
		services: [probe.service],
		state: { initial: { autoStart: [address] } },
	})
	try {
		await host.start()
		expect(events).toEqual(['original:init:true'])
		expect(visible.get(original.artifact)).toBe(original.bindings)
		await expect(host.updateCatalog([rejected.plugin])).rejects.toThrow('rejected RPC facts')
		expect(host.catalog().entries[0]?.candidate.implementation).toBe(original.plugin)
		expect(visible.get(original.artifact)).toBe(original.bindings)
		await host.updateCatalog([replacement.plugin])
		expect(events).toEqual(['original:init:true', 'original:stop:true', 'replacement:init:true'])
		expect(visible.has(original.artifact)).toBe(false)
		expect(visible.get(replacement.artifact)).toBe(replacement.bindings)
	} finally {
		await host.close()
	}
	expect(visible.size).toBe(0)
})

it('uses the same registration path for dynamic source replacement and withdrawal', async () => {
	const events: string[] = []
	const probe = rpcProbe()
	const original = builtPlugin('dynamic-original', probe.bindingsByArtifact, events)
	const replacement = builtPlugin('dynamic-replacement', probe.bindingsByArtifact, events)
	let callbacks!: PluginSourceOpenOptions
	let loaded: unknown = { RpcPlugin: original.plugin }
	const host = await createHost({
		plugins: [],
		services: [probe.service],
		root: '/',
		state: { initial: { autoStart: [address] } },
		sources: [
			{
				covers: () => true,
				async open(options) {
					callbacks = options
					return { entries: ['rpc.mjs'], close: async () => undefined }
				},
			},
		],
		loadModule: async () => loaded,
	})
	try {
		await host.start()
		expect(events).toEqual(['dynamic-original:init:true'])
		loaded = { RpcPlugin: replacement.plugin }
		callbacks.onChange({ type: 'change', path: 'rpc.mjs' })
		await host.updateCatalog([])
		expect(events).toEqual([
			'dynamic-original:init:true',
			'dynamic-original:stop:true',
			'dynamic-replacement:init:true',
		])
		expect(probe.bindingsByArtifact.has(original.artifact)).toBe(false)
		callbacks.onChange({ type: 'unlink', path: 'rpc.mjs' })
		await host.updateCatalog([])
		expect(probe.bindingsByArtifact.size).toBe(0)
	} finally {
		await host.close()
	}
})

it('admits RPC site facts when the RPC service is not installed', async () => {
	const events: string[] = []
	const facts = new Map<object, Readonly<Record<string, unknown>>>()
	const candidate = builtPlugin('disabled', facts, events)
	const host = await createHost({
		plugins: [candidate.plugin],
		state: { initial: { autoStart: [address] } },
	})
	try {
		await host.start()
		expect(events).toEqual(['disabled:init:false'])
	} finally {
		await host.close()
	}
})
