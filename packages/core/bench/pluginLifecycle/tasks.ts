import { Context } from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import type { Bench, FnOptions } from 'tinybench'
import { TASK, type TaskName } from './catalog.ts'
import {
	commit,
	dematerialize,
	isMaterialized,
	materialize,
	replace,
	restart,
	type Ctx,
	type Scenario,
} from './scenario.ts'

const isContext = (value: unknown): value is Ctx =>
	typeof value === 'object' &&
	value != null &&
	typeof (value as any).effects?.dispose === 'function'

async function assertRunning(ctx: Ctx, id: unknown) {
	if (!requirePluginService(ctx).isRunning(id as never)) {
		throw new Error(`Expected plugin to be running: ${String(id)}`)
	}
}

async function assertNotRegistered(ctx: Ctx, id: unknown) {
	if (isMaterialized(ctx, id as never)) {
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
			await commit(ctx)
			return { overriddenDuration: bench.now() - start }
		} finally {
			await ctx?.effects.dispose()
		}
	})
}

async function setupConfigHeavy(scenario: Scenario) {
	const ctx = new Context({ name: 'bench-config-heavy' })
	requireConfigService(ctx).patchConfig(scenario.configHeavy.address, scenario.configHeavy.record)
	materialize(ctx, scenario.configHeavy.ctor)
	await commit(ctx)
	return ctx
}

async function restoreAddLeaf(ctx: Ctx, scenario: Scenario) {
	if (!isMaterialized(ctx, scenario.star.addLeaf)) return
	dematerialize(ctx, scenario.star.addLeaf, { cascadeDependents: false })
	await commit(ctx)
	await assertNotRegistered(ctx, scenario.star.addLeaf)
}

async function restoreStarLeaf(ctx: Ctx, scenario: Scenario) {
	if (!isMaterialized(ctx, scenario.star.hotLeafV1)) {
		materialize(ctx, scenario.star.hotLeafV1)
	}
	await commit(ctx)
	await assertRunning(ctx, scenario.star.hotLeafV1)
}

async function restoreStarRoot(ctx: Ctx, scenario: Scenario) {
	if (!isMaterialized(ctx, scenario.star.rootV1)) {
		scenario.registerStar(ctx)
	}
	await commit(ctx)
	await assertRunning(ctx, scenario.star.hotLeafV1)
}

async function restoreChainMiddle(ctx: Ctx, scenario: Scenario) {
	if (isMaterialized(ctx, scenario.chain.middle)) return
	const start = scenario.chain.chain.indexOf(scenario.chain.middle)
	for (let i = start; i < scenario.chain.chain.length; i++) {
		materialize(ctx, scenario.chain.chain[i]!)
	}
	await commit(ctx)
	await assertRunning(ctx, scenario.chain.leaf)
}

async function revertReplace(ctx: Ctx, plugin: Scenario['star']['rootV1']) {
	replace(ctx, plugin, plugin)
	await commit(ctx)
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
			await commit(ctx)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.addLeafStar,
		() => scenario.setupStarGraph('bench-star-add'),
		async (ctx) => {
			materialize(ctx, scenario.star.addLeaf)
			await commit(ctx)
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
			restart(ctx, scenario.star.hotLeafV1)
			await commit(ctx)
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartRootStar,
		() => scenario.setupStarGraph('bench-star-restart-root'),
		async (ctx) => {
			restart(ctx, scenario.star.rootV1)
			await commit(ctx)
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceLeafStar,
		() => scenario.setupStarGraph('bench-star-replace-leaf'),
		async (ctx) => {
			replace(ctx, scenario.star.hotLeafV1, scenario.star.hotLeafV2)
			await commit(ctx)
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
			replace(ctx, scenario.star.rootV1, scenario.star.rootV2)
			await commit(ctx)
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
			dematerialize(ctx, scenario.star.hotLeafV1)
			await commit(ctx)
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
			dematerialize(ctx, scenario.star.rootV1)
			await commit(ctx)
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
			restart(ctx, scenario.chain.middle)
			await commit(ctx)
			await assertRunning(ctx, scenario.chain.leaf)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartChainLeaf,
		() => scenario.setupChainGraph('bench-chain-restart-leaf'),
		async (ctx) => {
			restart(ctx, scenario.chain.leaf)
			await commit(ctx)
			await assertRunning(ctx, scenario.chain.leaf)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.unregisterChainMiddle,
		() => scenario.setupChainGraph('bench-chain-unreg-middle'),
		async (ctx) => {
			dematerialize(ctx, scenario.chain.middle)
			await commit(ctx)
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
			restart(ctx, scenario.configHeavy.ctor)
			await commit(ctx)
			await assertRunning(ctx, scenario.configHeavy.ctor)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.noopLarge,
		() => scenario.setupBigStarGraph('bench-large-noop'),
		async (ctx) => {
			await commit(ctx)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.addLeafLarge,
		() => scenario.setupBigStarGraph('bench-large-add'),
		async (ctx) => {
			materialize(ctx, scenario.star.addLeaf)
			await commit(ctx)
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
			replace(ctx, scenario.star.hotLeafV1, scenario.star.hotLeafV2)
			await commit(ctx)
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
			replace(ctx, scenario.star.rootV1, scenario.star.rootV2)
			await commit(ctx)
			await assertRunning(ctx, scenario.star.hotLeafV1)
		},
		(ctx) => revertReplace(ctx, scenario.star.rootV1),
	)

	return () => {
		while (cleanups.length > 0) cleanups.pop()?.()
	}
}
