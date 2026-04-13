import { __registerConfigSchema__, BasePlugin, Context, Plugin, setParamTokens } from '@pluxel/core'

export type Ctx = InstanceType<typeof Context>
type CommitResult = Awaited<ReturnType<Ctx['registry']['commit']>>

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

function definePlugin(name: string, deps?: unknown[]): PluginCtor {
	class P extends BasePlugin {}
	if (deps?.length) setParamTokens(P, deps as any)
	Plugin({ name })(P)
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
	// Root has two implementations (same plugin id) to exercise replace().
	const rootV1 = definePlugin('BenchStarRoot')
	const rootV2 = definePlugin('BenchStarRoot')

	// A single leaf is hot-replaced (same plugin id).
	const hotLeafV1 = definePlugin('BenchStarHotLeaf', [rootV1])
	const hotLeafV2 = definePlugin('BenchStarHotLeaf', [rootV1])

	const leafCtors = Array<PluginCtor>(leaves)
	leafCtors[0] = hotLeafV1
	for (let i = 1; i < leaves; i++) leafCtors[i] = definePlugin(`BenchStarLeaf_${i}`, [rootV1])

	// Used for incremental add/remove.
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

	// Register schemas before @Plugin so the decorator can collect pending configMap in one pass.
	for (let i = 0; i < keys; i++) __registerConfigSchema__(P, `k${i}`, passthroughSchema)
	Plugin({ name: 'BenchConfigHeavy' })(P)

	const record: Record<string, unknown> = Object.create(null)
	for (let i = 0; i < keys; i++) record[`k${i}`] = i

	return { ctor: P as PluginCtor, id: 'BenchConfigHeavy', record }
}

export type ScenarioSizes = {
	starLeaves: number
	chainLength: number
	bigIndependent: number
	loops: number
	configKeys: number
}

export type Scenario = ReturnType<typeof createScenario>

export function createScenario(sizes: ScenarioSizes) {
	const star = createStar(sizes.starLeaves)
	const chain = createChain(sizes.chainLength)
	const bigIndependent = createIndependent('BenchBig_', sizes.bigIndependent)
	const configHeavy = createConfigHeavy(sizes.configKeys)

	const registerStar = (ctx: Ctx) => {
		ctx.registry.register(star.rootV1)
		for (let i = 0; i < star.leaves.length; i++) ctx.registry.register(star.leaves[i])
	}

	const registerChain = (ctx: Ctx) => {
		for (let i = 0; i < chain.chain.length; i++) ctx.registry.register(chain.chain[i])
	}

	const registerBigIndependent = (ctx: Ctx) => {
		for (let i = 0; i < bigIndependent.length; i++) ctx.registry.register(bigIndependent[i])
	}

	const setupStarBaseline = async (name: string): Promise<Ctx> => {
		const ctx = new Context({ name })
		registerStar(ctx)
		ensureOk(await ctx.registry.commit())
		return ctx
	}

	const setupChainBaseline = async (name: string): Promise<Ctx> => {
		const ctx = new Context({ name })
		registerChain(ctx)
		ensureOk(await ctx.registry.commit())
		return ctx
	}

	const setupBigStarBaseline = async (name: string): Promise<Ctx> => {
		const ctx = new Context({ name })
		registerBigIndependent(ctx)
		registerStar(ctx)
		ensureOk(await ctx.registry.commit())
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
		setupStarBaseline,
		setupChainBaseline,
		setupBigStarBaseline,
	}
}
