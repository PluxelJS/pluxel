import {
	BasePlugin,
	Context,
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
	Plugin,
} from '@pluxel/core'
import {
	consumePluginDefinitionCandidate,
	requirePluginService,
	type ConcretePluginDefinitionCandidate,
} from '@pluxel/core/internal'
import { __setPluginConfig, __setPluginDefinition } from '@pluxel/core/toolchain'

export type Ctx = InstanceType<typeof Context>
type Registry = ReturnType<typeof requirePluginService>
type Update = ReturnType<Registry['beginUpdate']>
type CommitResult = Awaited<ReturnType<Update['commit']>>

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

export type PluginCtor = new (...args: unknown[]) => BasePlugin

function definePlugin(name: string, deps?: PluginCtor[]): PluginCtor {
	class P extends BasePlugin {}
	Plugin({ displayName: name })(P)
	__setPluginDefinition(P, {
		abiVersion: 1,
		kind: 'plugin',
		definition: {
			entry: {
				kind: 'source-entry',
				sourceSpace: 'app',
				path: `core-bench/plugin-lifecycle/${name}`,
			},
			exportName: name,
		},
		requires: deps?.map(pluginDefinitionAddressOf),
	})
	return P
}

function createIndependent(prefix: string, count: number): PluginCtor[] {
	const list = Array<PluginCtor>(count)
	for (let i = 0; i < count; i++) list[i] = definePlugin(`${prefix}${i}`)
	return list
}

function createChain(length: number) {
	const chain = Array<PluginCtor>(length)
	let prev: PluginCtor | undefined
	for (let i = 0; i < length; i++) {
		const ctor = definePlugin(`BenchChain_${i}`, prev ? [prev] : undefined)
		chain[i] = ctor
		prev = ctor
	}
	return {
		chain,
		middle: chain[Math.floor(length / 2)]!,
		root: chain[0]!,
		leaf: chain[length - 1]!,
	}
}

function createStar(leaves: number) {
	// Same plugin id, different ctor: replace().
	const rootV1 = definePlugin('BenchStarRoot')
	const rootV2 = definePlugin('BenchStarRoot')

	const hotLeafV1 = definePlugin('BenchStarHotLeaf', [rootV1])
	const hotLeafV2 = definePlugin('BenchStarHotLeaf', [rootV1])

	const leafCtors = Array<PluginCtor>(leaves)
	leafCtors[0] = hotLeafV1
	for (let i = 1; i < leaves; i++) leafCtors[i] = definePlugin(`BenchStarLeaf_${i}`, [rootV1])

	const addLeaf = definePlugin('BenchStarAddLeaf', [rootV1])

	return {
		rootV1,
		rootV2,
		hotLeafV1,
		hotLeafV2,
		leaves: leafCtors,
		addLeaf,
	}
}

function createConfigHeavy(keys: number) {
	class P extends BasePlugin {}

	Plugin({ displayName: 'BenchConfigHeavy' })(P)
	__setPluginDefinition(P, {
		abiVersion: 1,
		kind: 'plugin',
		definition: {
			entry: {
				kind: 'source-entry',
				sourceSpace: 'app',
				path: 'core-bench/plugin-lifecycle/BenchConfigHeavy',
			},
			exportName: 'BenchConfigHeavy',
		},
	})
	__setPluginConfig(P, { abiVersion: 1, fieldName: 'config', schema: passthroughSchema })

	const record: Record<string, unknown> = Object.create(null)
	for (let i = 0; i < keys; i++) record[`k${i}`] = i

	return { ctor: P as PluginCtor, address: pluginNodeAddressOf(P), record }
}

export type ScenarioSizes = {
	starLeaves: number
	chainLength: number
	bigIndependent: number
	configKeys: number
}

export type Scenario = ReturnType<typeof createScenario>

const candidates = new WeakMap<PluginCtor, ConcretePluginDefinitionCandidate>()
const updates = new WeakMap<Ctx, Update>()

function candidateFor(PluginClass: PluginCtor): ConcretePluginDefinitionCandidate {
	const cached = candidates.get(PluginClass)
	if (cached) return cached
	const candidate = consumePluginDefinitionCandidate(PluginClass)
	candidates.set(PluginClass, candidate)
	return candidate
}

function currentUpdate(ctx: Ctx): Update {
	const active = updates.get(ctx)
	if (active) return active
	const update = requirePluginService(ctx).beginUpdate({ reason: 'core-lifecycle-benchmark' })
	updates.set(ctx, update)
	return update
}

export function materialize(ctx: Ctx, PluginClass: PluginCtor): void {
	currentUpdate(ctx).materializeNode(pluginNodeAddressOf(PluginClass), candidateFor(PluginClass))
}

export function dematerialize(
	ctx: Ctx,
	PluginClass: PluginCtor,
	options?: { cascadeDependents?: boolean },
): void {
	currentUpdate(ctx).dematerializeNode(pluginNodeAddressOf(PluginClass), options)
}

export function restart(ctx: Ctx, PluginClass: PluginCtor): void {
	currentUpdate(ctx).restartNode(pluginNodeAddressOf(PluginClass))
}

export function replace(ctx: Ctx, target: PluginCtor, next: PluginCtor): void {
	const address = pluginDefinitionAddressOf(target)
	currentUpdate(ctx).replaceDefinition(address, candidateFor(next))
}

export function isMaterialized(ctx: Ctx, PluginClass: PluginCtor): boolean {
	return requirePluginService(ctx).isMaterialized(pluginNodeAddressOf(PluginClass))
}

export async function commit(ctx: Ctx): Promise<void> {
	const update =
		updates.get(ctx) ??
		requirePluginService(ctx).beginUpdate({ reason: 'core-lifecycle-benchmark' })
	updates.delete(ctx)
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
	const configHeavy = createConfigHeavy(sizes.configKeys)

	const registerStar = (ctx: Ctx) => {
		materialize(ctx, star.rootV1)
		for (let i = 0; i < star.leaves.length; i++) materialize(ctx, star.leaves[i]!)
	}

	const registerChain = (ctx: Ctx) => {
		for (let i = 0; i < chain.chain.length; i++) materialize(ctx, chain.chain[i]!)
	}

	const registerBigIndependent = (ctx: Ctx) => {
		for (let i = 0; i < bigIndependent.length; i++) materialize(ctx, bigIndependent[i]!)
	}

	const setupStarGraph = async (name: string): Promise<Ctx> => {
		const ctx = new Context({ name })
		registerStar(ctx)
		await commit(ctx)
		return ctx
	}

	const setupChainGraph = async (name: string): Promise<Ctx> => {
		const ctx = new Context({ name })
		registerChain(ctx)
		await commit(ctx)
		return ctx
	}

	const setupBigStarGraph = async (name: string): Promise<Ctx> => {
		const ctx = new Context({ name })
		registerBigIndependent(ctx)
		registerStar(ctx)
		await commit(ctx)
		return ctx
	}

	return {
		sizes,
		star,
		chain,
		bigIndependent,
		configHeavy,
		registerStar,
		registerChain,
		registerBigIndependent,
		setupStarGraph,
		setupChainGraph,
		setupBigStarGraph,
	}
}
