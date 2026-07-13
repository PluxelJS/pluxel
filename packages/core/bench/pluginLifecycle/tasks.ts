import { Context } from '@pluxel/core'
import type { Bench, FnOptions } from 'tinybench'
import { TASK, type TaskName } from './catalog.ts'
import { ensureOk, type Ctx, type Scenario } from './scenario.ts'

const isContext = (value: unknown): value is Ctx =>
	typeof value === 'object' &&
	value != null &&
	typeof (value as any).effects?.dispose === 'function'

async function assertRunning(ctx: Ctx, id: unknown) {
	if (!ctx.registry.isRunning(id as never)) {
		throw new Error(`Expected plugin to be running: ${String(id)}`)
	}
}

async function assertNotRegistered(ctx: Ctx, id: unknown) {
	if (ctx.registry.isRegistered(id as never)) {
		throw new Error(`Expected plugin to be unregistered: ${String(id)}`)
	}
}

function steadyTask(
	bench: Bench,
	cleanups: Array<() => void>,
	name: TaskName,
	setup: () => Promise<Ctx>,
	run: (state: Ctx) => Promise<void>,
	restore?: (state: Ctx) => Promise<void>,
) {
	let state: Ctx | undefined
	let disposed = false
	const dispose = () => {
		if (disposed) return
		disposed = true
		const current = state
		state = undefined
		if (!isContext(current)) return
		void current.effects.dispose().catch(() => {
			/* best-effort cleanup */
		})
	}
	cleanups.push(dispose)

	const options: FnOptions = {
		async beforeAll() {
			disposed = false
			state = await setup()
		},
		async afterEach() {
			if (state && restore) await restore(state)
		},
		afterAll() {
			dispose()
		},
	}

	return bench.add(
		name,
		async () => {
			if (!state) throw new Error(`Benchmark task "${name}" was not prepared`)
			await run(state)
		},
		options,
	)
}

function coldTask(bench: Bench, name: TaskName, run: (ctx: Ctx) => Promise<void> | void) {
	return bench.add(name, async () => {
		let ctx: Ctx | undefined
		const start = bench.now()
		try {
			ctx = new Context({ name: `bench-${name}` })
			await run(ctx)
			ensureOk(await ctx.registry.commit())
			return { overriddenDuration: bench.now() - start }
		} finally {
			await ctx?.effects.dispose()
		}
	})
}

async function setupConfigHeavy(scenario: Scenario) {
	const ctx = new Context({ name: 'bench-config-heavy' })
	ctx.configService.patchConfig(scenario.configHeavy.id, scenario.configHeavy.record)
	ctx.registry.register(scenario.configHeavy.ctor)
	ensureOk(await ctx.registry.commit())
	return ctx
}

async function restoreAddLeaf(ctx: Ctx, scenario: Scenario) {
	if (!ctx.registry.isRegistered(scenario.star.addLeaf as never)) return
	ctx.registry.unregister(scenario.star.addLeaf, { cascadeDependents: false })
	ensureOk(await ctx.registry.commit())
	await assertNotRegistered(ctx, scenario.star.addLeaf)
}

async function restoreStarLeaf(ctx: Ctx, scenario: Scenario) {
	if (!ctx.registry.isRegistered(scenario.star.hotLeafV1 as never)) {
		ctx.registry.register(scenario.star.hotLeafV1)
	}
	ensureOk(await ctx.registry.commit())
	await assertRunning(ctx, scenario.star.hotLeafV1)
}

async function restoreStarRoot(ctx: Ctx, scenario: Scenario) {
	if (!ctx.registry.isRegistered(scenario.star.rootV1 as never)) {
		scenario.registerStar(ctx)
	}
	ensureOk(await ctx.registry.commit())
	await assertRunning(ctx, scenario.star.hotLeafV1)
}

async function restoreChainMiddle(ctx: Ctx, scenario: Scenario) {
	if (ctx.registry.isRegistered(scenario.chain.middle as never)) return
	const start = scenario.chain.chain.indexOf(scenario.chain.middle)
	for (let i = start; i < scenario.chain.chain.length; i++) {
		ctx.registry.register(scenario.chain.chain[i]!)
	}
	ensureOk(await ctx.registry.commit())
	await assertRunning(ctx, scenario.chain.leaf)
}

async function revertReplace(ctx: Ctx, plugin: unknown) {
	ctx.registry.replace(plugin as never, plugin as never)
	ensureOk(await ctx.registry.commit())
	await assertRunning(ctx, plugin)
}

export function registerPluginLifecycleBenchmarks(bench: Bench, scenario: Scenario) {
	const cleanups: Array<() => void> = []

	coldTask(bench, TASK.coldStar, (ctx) => {
		scenario.registerStar(ctx)
	})

	coldTask(bench, TASK.coldChain, (ctx) => {
		scenario.registerChain(ctx)
	})

	coldTask(bench, TASK.coldLarge, (ctx) => {
		scenario.registerBigIndependent(ctx)
		scenario.registerStar(ctx)
	})

	steadyTask(
		bench,
		cleanups,
		TASK.noopStar,
		() => scenario.setupStarGraph('bench-star-noop'),
		async (ctx) => {
			ensureOk(await ctx.registry.commit())
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.addLeafStar,
		() => scenario.setupStarGraph('bench-star-add'),
		async (ctx) => {
			ctx.registry.register(scenario.star.addLeaf)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.star.addLeaf)
		},
		(ctx) => restoreAddLeaf(ctx, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartLeafStar,
		() => scenario.setupStarGraph('bench-star-restart-leaf'),
		async (ctx) => {
			ctx.registry.restart(scenario.star.hotLeafV1)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartRootStar,
		() => scenario.setupStarGraph('bench-star-restart-root'),
		async (ctx) => {
			ctx.registry.restart(scenario.star.rootV1)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceLeafStar,
		() => scenario.setupStarGraph('bench-star-replace-leaf'),
		async (ctx) => {
			ctx.registry.replace(scenario.star.hotLeafV1, scenario.star.hotLeafV2)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
		(ctx) => revertReplace(ctx, scenario.star.hotLeafV1),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceRootStar,
		() => scenario.setupStarGraph('bench-star-replace-root'),
		async (ctx) => {
			ctx.registry.replace(scenario.star.rootV1, scenario.star.rootV2)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
		(ctx) => revertReplace(ctx, scenario.star.rootV1),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.unregisterLeafStar,
		() => scenario.setupStarGraph('bench-star-unreg-leaf'),
		async (ctx) => {
			ctx.registry.unregister(scenario.star.hotLeafV1)
			ensureOk(await ctx.registry.commit())
			await assertNotRegistered(ctx, scenario.star.hotLeafV1)
		},
		(ctx) => restoreStarLeaf(ctx, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.unregisterRootStar,
		() => scenario.setupStarGraph('bench-star-unreg-root'),
		async (ctx) => {
			ctx.registry.unregister(scenario.star.rootV1)
			ensureOk(await ctx.registry.commit())
			await assertNotRegistered(ctx, scenario.star.rootV1)
		},
		(ctx) => restoreStarRoot(ctx, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartChainMiddle,
		() => scenario.setupChainGraph('bench-chain-restart-middle'),
		async (ctx) => {
			ctx.registry.restart(scenario.chain.middle)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.chain.leaf)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartChainLeaf,
		() => scenario.setupChainGraph('bench-chain-restart-leaf'),
		async (ctx) => {
			ctx.registry.restart(scenario.chain.leaf)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.chain.leaf)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.unregisterChainMiddle,
		() => scenario.setupChainGraph('bench-chain-unreg-middle'),
		async (ctx) => {
			ctx.registry.unregister(scenario.chain.middle)
			ensureOk(await ctx.registry.commit())
			await assertNotRegistered(ctx, scenario.chain.middle)
		},
		(ctx) => restoreChainMiddle(ctx, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.configRestart,
		() => setupConfigHeavy(scenario),
		async (ctx) => {
			ctx.registry.restart(scenario.configHeavy.ctor)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.configHeavy.ctor)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.noopLarge,
		() => scenario.setupBigStarGraph('bench-large-noop'),
		async (ctx) => {
			ensureOk(await ctx.registry.commit())
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.addLeafLarge,
		() => scenario.setupBigStarGraph('bench-large-add'),
		async (ctx) => {
			ctx.registry.register(scenario.star.addLeaf)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.star.addLeaf)
		},
		(ctx) => restoreAddLeaf(ctx, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceLeafLarge,
		() => scenario.setupBigStarGraph('bench-large-replace-leaf'),
		async (ctx) => {
			ctx.registry.replace(scenario.star.hotLeafV1, scenario.star.hotLeafV2)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
		(ctx) => revertReplace(ctx, scenario.star.hotLeafV1),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceRootLarge,
		() => scenario.setupBigStarGraph('bench-large-replace-root'),
		async (ctx) => {
			ctx.registry.replace(scenario.star.rootV1, scenario.star.rootV2)
			ensureOk(await ctx.registry.commit())
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
		(ctx) => revertReplace(ctx, scenario.star.rootV1),
	)

	return () => {
		while (cleanups.length > 0) cleanups.pop()?.()
	}
}
