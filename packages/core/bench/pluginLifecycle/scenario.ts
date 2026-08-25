import {
	BasePlugin,
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
	Plugin,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
	type RootContext,
} from '@pluxel/core'
import {
	consumePluginDefinitionCandidate,
	createCoreRootContext,
	requirePluginService,
	type ConcretePluginDefinitionCandidate,
} from '@pluxel/core/internal'
import { __setPluginConfig, __setPluginDefinition } from '@pluxel/core/toolchain'

export type Ctx = RootContext
export type Registry = ReturnType<typeof requirePluginService>
export type Update = ReturnType<Registry['beginUpdate']>
type CommitResult = Awaited<ReturnType<Update['commit']>>

export type BenchHost = Readonly<{
	ctx: Ctx
	plugins: Registry
}>

export type PluginCtor = new (...args: unknown[]) => BasePlugin

export type PluginFixture = Readonly<{
	ctor: PluginCtor
	definitionAddress: PluginDefinitionAddress
	nodeAddress: PluginNodeAddress
	candidate: ConcretePluginDefinitionCandidate
}>

const passthroughSchema = {
	'~standard': {
		version: 1,
		validate: (input: unknown) => ({ value: input }),
	},
} as const

export const ensureOk = (result: CommitResult) => {
	if (!result.ok) {
		throw (result as any).err ?? new Error('Commit failed')
	}
}

function definePlugin(name: string, deps?: readonly PluginFixture[]): PluginFixture {
	class P extends BasePlugin {}
	Plugin({ displayName: name })(P)
	__setPluginDefinition(P, {
		abiVersion: 2,
		kind: 'plugin',
		definition: {
			entry: {
				kind: 'source-entry',
				sourceSpace: 'app',
				path: `core-bench/plugin-lifecycle/${name}`,
			},
			exportName: name,
		},
		constructorRequires: deps?.map((dependency) => dependency.definitionAddress),
	})
	return pluginFixture(P)
}

function pluginFixture(ctor: PluginCtor): PluginFixture {
	return Object.freeze({
		ctor,
		definitionAddress: pluginDefinitionAddressOf(ctor),
		nodeAddress: pluginNodeAddressOf(ctor),
		candidate: consumePluginDefinitionCandidate(ctor),
	})
}

function createIndependent(prefix: string, count: number): PluginFixture[] {
	const list = Array<PluginFixture>(count)
	for (let i = 0; i < count; i++) list[i] = definePlugin(`${prefix}${i}`)
	return list
}

function createChain(length: number) {
	const chain = Array<PluginFixture>(length)
	let previous: PluginFixture | undefined
	for (let i = 0; i < length; i++) {
		const plugin = definePlugin(`BenchChain_${i}`, previous ? [previous] : undefined)
		chain[i] = plugin
		previous = plugin
	}
	return {
		chain,
		middle: chain[Math.floor(length / 2)]!,
		root: chain[0]!,
		leaf: chain[length - 1]!,
	}
}

function createStar(leaves: number) {
	// Same definition address, different implementation candidate: replaceDefinition().
	const rootV1 = definePlugin('BenchStarRoot')
	const rootV2 = definePlugin('BenchStarRoot')

	const hotLeafV1 = definePlugin('BenchStarHotLeaf', [rootV1])
	const hotLeafV2 = definePlugin('BenchStarHotLeaf', [rootV1])

	const leafFixtures = Array<PluginFixture>(leaves)
	leafFixtures[0] = hotLeafV1
	for (let i = 1; i < leaves; i++) {
		leafFixtures[i] = definePlugin(`BenchStarLeaf_${i}`, [rootV1])
	}

	const addLeaf = definePlugin('BenchStarAddLeaf', [rootV1])

	return {
		rootV1,
		rootV2,
		hotLeafV1,
		hotLeafV2,
		leaves: leafFixtures,
		addLeaf,
	}
}

function createConfiguredPlugin() {
	class P extends BasePlugin {}

	Plugin({ displayName: 'BenchConfigured' })(P)
	__setPluginDefinition(P, {
		abiVersion: 2,
		kind: 'plugin',
		definition: {
			entry: {
				kind: 'source-entry',
				sourceSpace: 'app',
				path: 'core-bench/plugin-lifecycle/BenchConfigured',
			},
			exportName: 'BenchConfigured',
		},
	})
	__setPluginConfig(P, { abiVersion: 2, fieldName: 'config', schema: passthroughSchema })

	return {
		plugin: pluginFixture(P),
		record: Object.freeze({ value: 1 }) as Readonly<Record<string, unknown>>,
	}
}

export type ScenarioSizes = {
	starLeaves: number
	chainLength: number
	bigIndependent: number
}

export type Scenario = ReturnType<typeof createScenario>

export function createBenchHost(name: string): BenchHost {
	const ctx = createCoreRootContext({ name })
	return Object.freeze({ ctx, plugins: requirePluginService(ctx) })
}

export function beginUpdate(host: BenchHost, reason: string): Update {
	return host.plugins.beginUpdate({ reason })
}

export function materialize(update: Update, plugin: PluginFixture): void {
	update.materializeNode(plugin.nodeAddress, plugin.candidate)
}

export function dematerialize(
	update: Update,
	plugin: PluginFixture,
	options?: { cascadeDependents?: boolean },
): void {
	update.dematerializeNode(plugin.nodeAddress, options)
}

export function restart(update: Update, plugin: PluginFixture): void {
	update.restartNode(plugin.nodeAddress)
}

export function replace(update: Update, target: PluginFixture, next: PluginFixture): void {
	update.replaceDefinition(target.definitionAddress, next.candidate)
}

export function isMaterialized(host: BenchHost, plugin: PluginFixture): boolean {
	return host.plugins.isMaterialized(plugin.nodeAddress)
}

export async function commit(update: Update): Promise<void> {
	try {
		ensureOk(await update.commit())
	} catch (error) {
		update.rollback()
		throw error
	}
}

export function createScenario(sizes: ScenarioSizes) {
	const star = createStar(sizes.starLeaves)
	const chain = createChain(sizes.chainLength)
	const bigIndependent = createIndependent('BenchBig_', sizes.bigIndependent)
	const configured = createConfiguredPlugin()

	const registerStar = (update: Update) => {
		materialize(update, star.rootV1)
		for (const leaf of star.leaves) materialize(update, leaf)
	}

	const registerChain = (update: Update) => {
		for (const plugin of chain.chain) materialize(update, plugin)
	}

	const registerBigIndependent = (update: Update) => {
		for (const plugin of bigIndependent) materialize(update, plugin)
	}

	const setupStarGraph = async (name: string): Promise<BenchHost> => {
		const host = createBenchHost(name)
		const update = beginUpdate(host, 'core-lifecycle-benchmark-setup-star')
		registerStar(update)
		await commit(update)
		return host
	}

	const setupChainGraph = async (name: string): Promise<BenchHost> => {
		const host = createBenchHost(name)
		const update = beginUpdate(host, 'core-lifecycle-benchmark-setup-chain')
		registerChain(update)
		await commit(update)
		return host
	}

	const setupBigStarGraph = async (name: string): Promise<BenchHost> => {
		const host = createBenchHost(name)
		const update = beginUpdate(host, 'core-lifecycle-benchmark-setup-large')
		registerBigIndependent(update)
		registerStar(update)
		await commit(update)
		return host
	}

	return {
		sizes,
		star,
		chain,
		bigIndependent,
		configured,
		registerStar,
		registerChain,
		registerBigIndependent,
		setupStarGraph,
		setupChainGraph,
		setupBigStarGraph,
	}
}
