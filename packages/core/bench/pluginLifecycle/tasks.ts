import { requireConfigService } from '@pluxel/core/internal'
import type { Bench, FnOptions } from 'tinybench'
import { TASK, type TaskName } from './catalog.ts'
import {
	beginUpdate,
	commit,
	createBenchHost,
	dematerialize,
	isMaterialized,
	materialize,
	replace,
	restart,
	type BenchHost,
	type PluginFixture,
	type Scenario,
	type Update,
} from './scenario.ts'

const isBenchHost = (value: unknown): value is BenchHost =>
	typeof value === 'object' &&
	value != null &&
	typeof (value as any).ctx?.effects?.dispose === 'function'

async function assertRunning(host: BenchHost, plugin: PluginFixture) {
	if (!host.plugins.isRunning(plugin.nodeAddress)) {
		throw new Error(`Expected plugin to be running: ${plugin.candidate.declaration.displayName}`)
	}
}

async function assertNotMaterialized(host: BenchHost, plugin: PluginFixture) {
	if (isMaterialized(host, plugin)) {
		throw new Error(
			`Expected plugin to be dematerialized: ${plugin.candidate.declaration.displayName}`,
		)
	}
}

function steadyTask(
	bench: Bench,
	cleanups: Array<() => void>,
	name: TaskName,
	setup: () => Promise<BenchHost>,
	run: (state: BenchHost) => Promise<void>,
	validate?: (state: BenchHost) => Promise<void>,
	restore?: (state: BenchHost) => Promise<void>,
) {
	let state: BenchHost | undefined
	let disposed = false
	const dispose = () => {
		if (disposed) return
		disposed = true
		const current = state
		state = undefined
		if (!isBenchHost(current)) return
		void current.ctx.effects.dispose().catch(() => {
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
			if (!state) return
			try {
				if (validate) await validate(state)
			} finally {
				if (restore) await restore(state)
			}
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

function coldTask(bench: Bench, name: TaskName, run: (update: Update) => void) {
	return bench.add(name, async () => {
		let host: BenchHost | undefined
		let update: Update | undefined
		const start = bench.now()
		try {
			host = createBenchHost(`bench-${name}`)
			update = beginUpdate(host, `core-lifecycle-benchmark-${name}`)
			run(update)
			await commit(update)
			return { overriddenDuration: bench.now() - start }
		} catch (error) {
			update?.rollback()
			throw error
		} finally {
			await host?.ctx.effects.dispose()
		}
	})
}

async function setupConfigured(scenario: Scenario) {
	const host = createBenchHost('bench-config-cached-object')
	requireConfigService(host.ctx).patchConfig(
		scenario.configured.plugin.nodeAddress,
		scenario.configured.record,
	)
	const update = beginUpdate(host, 'core-lifecycle-benchmark-setup-configured')
	materialize(update, scenario.configured.plugin)
	await commit(update)
	return host
}

async function restoreAddLeaf(host: BenchHost, scenario: Scenario) {
	if (!isMaterialized(host, scenario.star.addLeaf)) return
	const update = beginUpdate(host, 'core-lifecycle-benchmark-restore-added-leaf')
	dematerialize(update, scenario.star.addLeaf, { cascadeDependents: false })
	await commit(update)
	await assertNotMaterialized(host, scenario.star.addLeaf)
}

async function restoreStarLeaf(host: BenchHost, scenario: Scenario) {
	if (!isMaterialized(host, scenario.star.hotLeafV1)) {
		const update = beginUpdate(host, 'core-lifecycle-benchmark-restore-star-leaf')
		materialize(update, scenario.star.hotLeafV1)
		await commit(update)
	}
	await assertRunning(host, scenario.star.hotLeafV1)
}

async function restoreStarRoot(host: BenchHost, scenario: Scenario) {
	if (!isMaterialized(host, scenario.star.rootV1)) {
		const update = beginUpdate(host, 'core-lifecycle-benchmark-restore-star-root')
		scenario.registerStar(update)
		await commit(update)
	}
	await assertRunning(host, scenario.star.hotLeafV1)
}

async function restoreChainMiddle(host: BenchHost, scenario: Scenario) {
	if (!isMaterialized(host, scenario.chain.middle)) {
		const update = beginUpdate(host, 'core-lifecycle-benchmark-restore-chain-middle')
		const start = scenario.chain.chain.indexOf(scenario.chain.middle)
		for (let i = start; i < scenario.chain.chain.length; i++) {
			materialize(update, scenario.chain.chain[i]!)
		}
		await commit(update)
	}
	await assertRunning(host, scenario.chain.leaf)
}

async function revertReplace(host: BenchHost, plugin: PluginFixture) {
	const update = beginUpdate(host, 'core-lifecycle-benchmark-revert-replacement')
	replace(update, plugin, plugin)
	await commit(update)
	await assertRunning(host, plugin)
}

export function registerPluginLifecycleBenchmarks(bench: Bench, scenario: Scenario) {
	const cleanups: Array<() => void> = []

	coldTask(bench, TASK.coldStar, scenario.registerStar)
	coldTask(bench, TASK.coldChain, scenario.registerChain)
	coldTask(bench, TASK.coldLarge, (update) => {
		scenario.registerBigIndependent(update)
		scenario.registerStar(update)
	})

	steadyTask(
		bench,
		cleanups,
		TASK.noopStar,
		() => scenario.setupStarGraph('bench-star-noop'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-empty-star')
			await commit(update)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.addLeafStar,
		() => scenario.setupStarGraph('bench-star-add'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-add-leaf-star')
			materialize(update, scenario.star.addLeaf)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.star.addLeaf),
		(host) => restoreAddLeaf(host, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartLeafStar,
		() => scenario.setupStarGraph('bench-star-restart-leaf'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-restart-leaf-star')
			restart(update, scenario.star.hotLeafV1)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.star.hotLeafV1),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartRootStar,
		() => scenario.setupStarGraph('bench-star-restart-root'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-restart-root-star')
			restart(update, scenario.star.rootV1)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.star.hotLeafV1),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceLeafStar,
		() => scenario.setupStarGraph('bench-star-replace-leaf'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-replace-leaf-star')
			replace(update, scenario.star.hotLeafV1, scenario.star.hotLeafV2)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.star.hotLeafV1),
		(host) => revertReplace(host, scenario.star.hotLeafV1),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceRootStar,
		() => scenario.setupStarGraph('bench-star-replace-root'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-replace-root-star')
			replace(update, scenario.star.rootV1, scenario.star.rootV2)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.star.hotLeafV1),
		(host) => revertReplace(host, scenario.star.rootV1),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.unregisterLeafStar,
		() => scenario.setupStarGraph('bench-star-unreg-leaf'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-remove-leaf-star')
			dematerialize(update, scenario.star.hotLeafV1)
			await commit(update)
		},
		(host) => assertNotMaterialized(host, scenario.star.hotLeafV1),
		(host) => restoreStarLeaf(host, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.unregisterRootStar,
		() => scenario.setupStarGraph('bench-star-unreg-root'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-remove-root-star')
			dematerialize(update, scenario.star.rootV1)
			await commit(update)
		},
		(host) => assertNotMaterialized(host, scenario.star.rootV1),
		(host) => restoreStarRoot(host, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartChainMiddle,
		() => scenario.setupChainGraph('bench-chain-restart-middle'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-restart-chain-middle')
			restart(update, scenario.chain.middle)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.chain.leaf),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.restartChainLeaf,
		() => scenario.setupChainGraph('bench-chain-restart-leaf'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-restart-chain-leaf')
			restart(update, scenario.chain.leaf)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.chain.leaf),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.unregisterChainMiddle,
		() => scenario.setupChainGraph('bench-chain-unreg-middle'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-remove-chain-middle')
			dematerialize(update, scenario.chain.middle)
			await commit(update)
		},
		(host) => assertNotMaterialized(host, scenario.chain.middle),
		(host) => restoreChainMiddle(host, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.configRestart,
		() => setupConfigured(scenario),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-restart-configured')
			restart(update, scenario.configured.plugin)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.configured.plugin),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.noopLarge,
		() => scenario.setupBigStarGraph('bench-large-noop'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-empty-large')
			await commit(update)
		},
	)

	steadyTask(
		bench,
		cleanups,
		TASK.addLeafLarge,
		() => scenario.setupBigStarGraph('bench-large-add'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-add-leaf-large')
			materialize(update, scenario.star.addLeaf)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.star.addLeaf),
		(host) => restoreAddLeaf(host, scenario),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceLeafLarge,
		() => scenario.setupBigStarGraph('bench-large-replace-leaf'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-replace-leaf-large')
			replace(update, scenario.star.hotLeafV1, scenario.star.hotLeafV2)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.star.hotLeafV1),
		(host) => revertReplace(host, scenario.star.hotLeafV1),
	)

	steadyTask(
		bench,
		cleanups,
		TASK.replaceRootLarge,
		() => scenario.setupBigStarGraph('bench-large-replace-root'),
		async (host) => {
			const update = beginUpdate(host, 'core-lifecycle-benchmark-replace-root-large')
			replace(update, scenario.star.rootV1, scenario.star.rootV2)
			await commit(update)
		},
		(host) => assertRunning(host, scenario.star.hotLeafV1),
		(host) => revertReplace(host, scenario.star.rootV1),
	)

	return () => {
		while (cleanups.length > 0) cleanups.pop()?.()
	}
}
