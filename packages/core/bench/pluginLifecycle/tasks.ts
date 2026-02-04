import { Context } from '@pluxel/core'
import type { Bench } from 'tinybench'
import { ensureOk, type Ctx, type Scenario } from './scenario'

type Area =
	| 'diod build/verify'
	| 'dependency planning'
	| 'dependents traversal'
	| 'lifecycle restart'
	| 'config injection'
	| 'noop/overhead'

export const TASK_MEANING: Record<string, { goal: string; area: Area; notes?: string }> = {
	'cold: build star baseline': {
		goal: 'Cold start: build+verify a fan-out graph (root -> many leaves).',
		area: 'diod build/verify',
	},
	'cold: build chain baseline': {
		goal: 'Cold start: build+verify a deep dependency chain.',
		area: 'diod build/verify',
	},
	'cold: build big baseline (independent + star)': {
		goal: 'Cold start: build+verify a large mostly-independent baseline plus a star.',
		area: 'diod build/verify',
		notes: 'Surfaces scaling of build/verify with many services.',
	},
	'baseline: noop commit (star)': {
		goal: 'Commit without pending ops (measures orchestration overhead only).',
		area: 'noop/overhead',
	},
	'incremental: add/remove leaf (star)': {
		goal: 'Small change on stable star baseline (register/unregister single plugin).',
		area: 'diod build/verify',
	},
	'restart: leaf (star)': {
		goal: 'Restart a low-fanout plugin on a stable star baseline.',
		area: 'lifecycle restart',
		notes: 'No DI rebuild; measures instance churn + lifecycle + config injection.',
	},
	'restart: root (star)': {
		goal: 'Restart a high-fanout root (cascades to many dependents).',
		area: 'dependents traversal',
		notes: 'No DI rebuild; stresses teardown order + restart scheduling.',
	},
	'hmr: replace leaf (star)': {
		goal: 'HMR replace leaf implementation (alias + restart).',
		area: 'diod build/verify',
	},
	'hmr: replace root (star)': {
		goal: 'HMR replace root implementation (worst-case cascade).',
		area: 'dependents traversal',
	},
	'unregister: leaf cascade (star)': {
		goal: 'Unregister a leaf with default cascade semantics.',
		area: 'dependents traversal',
	},
	'unregister: root cascade (star)': {
		goal: 'Unregister the root with default cascade semantics (worst-case).',
		area: 'dependents traversal',
	},
	'restart: chain middle (deep)': {
		goal: 'Restart a middle node in a deep chain (cascades downstream).',
		area: 'dependents traversal',
	},
	'restart: chain leaf (deep)': {
		goal: 'Restart a leaf in a deep chain (minimal cascade).',
		area: 'lifecycle restart',
	},
	'unregister: chain middle cascade (deep)': {
		goal: 'Unregister a middle chain node (cascade, then re-register).',
		area: 'dependents traversal',
	},
	'config: inject-heavy restart': {
		goal: 'Restart a plugin with many config keys and a large config record.',
		area: 'config injection',
	},
	'big: noop commit (independent + star)': {
		goal: 'No-op commit with a large baseline present.',
		area: 'noop/overhead',
	},
	'big: incremental add/remove leaf (independent + star)': {
		goal: 'Small change with a large baseline present (build/verify scaling).',
		area: 'diod build/verify',
	},
	'big: hmr replace leaf (independent + star)': {
		goal: 'HMR replace leaf with a large baseline present (scaling + restart).',
		area: 'diod build/verify',
	},
	'big: hmr replace root (independent + star)': {
		goal: 'HMR replace root with a large baseline present (worst-case scaling).',
		area: 'dependents traversal',
	},
}

const isContext = (value: unknown): value is Ctx =>
	typeof value === 'object' &&
	value != null &&
	typeof (value as any).effects?.dispose === 'function'

function stableTask<T>(
	bench: Bench,
	cleanups: Array<() => void>,
	name: string,
	setup: () => Promise<T>,
	run: (state: T) => Promise<void>,
) {
	let state: T | undefined
	let registeredCleanup = false
	return bench.add(name, async () => {
		if (!state) state = await setup()
		if (!registeredCleanup && isContext(state)) {
			registeredCleanup = true
			cleanups.push(() => {
				void state.effects.dispose().catch(() => {
					/* best-effort bench cleanup */
				})
			})
		}
		await run(state)
	})
}

const repeat = async (count: number, op: () => Promise<void>) => {
	for (let i = 0; i < count; i++) await op()
}

export function registerPluginLifecycleBenchmarks(bench: Bench, scenario: Scenario) {
	const cleanups: Array<() => void> = []
	const loops = scenario.sizes.loops

	// -----------------------------------------------------------------------
	// Cold-start builds (fresh context each invocation).
	// -----------------------------------------------------------------------
	bench
		.add('cold: build star baseline', async () => {
			const ctx = new Context({ name: 'bench-cold-star' })
			scenario.registerStar(ctx)
			ensureOk(await ctx.registry.commit())
			await ctx.effects.dispose()
		})
		.add('cold: build chain baseline', async () => {
			const ctx = new Context({ name: 'bench-cold-chain' })
			scenario.registerChain(ctx)
			ensureOk(await ctx.registry.commit())
			await ctx.effects.dispose()
		})
		.add('cold: build big baseline (independent + star)', async () => {
			const ctx = new Context({ name: 'bench-cold-big' })
			scenario.registerBigIndependent(ctx)
			scenario.registerStar(ctx)
			ensureOk(await ctx.registry.commit())
			await ctx.effects.dispose()
		})

	// ---------------------------------------------------------------------------
	// Steady-state / incremental operations (stable baseline reused across runs).
	// This is closer to how real apps behave (baseline stays, you mutate a bit).
	// ---------------------------------------------------------------------------

	stableTask(bench, cleanups, 'baseline: noop commit (star)', () => scenario.setupStarBaseline('bench-star-noop'), async (ctx) => {
		ensureOk(await ctx.registry.commit())
	})

	stableTask(
		bench,
		cleanups,
		'incremental: add/remove leaf (star)',
		() => scenario.setupStarBaseline('bench-star-add-remove'),
		async (ctx) => {
			await repeat(loops, async () => {
				ctx.registry.register(scenario.star.addLeaf)
				ensureOk(await ctx.registry.commit())
				ctx.registry.unregister(scenario.star.addLeaf, { cascadeDependents: false })
				ensureOk(await ctx.registry.commit())
			})
		},
	)

	stableTask(bench, cleanups, 'restart: leaf (star)', () => scenario.setupStarBaseline('bench-star-restart-leaf'), async (ctx) => {
		await repeat(loops, async () => {
			ctx.registry.restart(scenario.star.hotLeafV1)
			ensureOk(await ctx.registry.commit())
		})
	})

	stableTask(bench, cleanups, 'restart: root (star)', () => scenario.setupStarBaseline('bench-star-restart-root'), async (ctx) => {
		await repeat(loops, async () => {
			ctx.registry.restart(scenario.star.rootV1)
			ensureOk(await ctx.registry.commit())
		})
	})

	stableTask(bench, cleanups, 'hmr: replace leaf (star)', () => scenario.setupStarBaseline('bench-star-replace-leaf'), async (ctx) => {
		await repeat(loops, async () => {
			ctx.registry.replace(scenario.star.hotLeafV1, scenario.star.hotLeafV2)
			ensureOk(await ctx.registry.commit())
			ctx.registry.replace(scenario.star.hotLeafV1, scenario.star.hotLeafV1)
			ensureOk(await ctx.registry.commit())
		})
	})

	stableTask(bench, cleanups, 'hmr: replace root (star)', () => scenario.setupStarBaseline('bench-star-replace-root'), async (ctx) => {
		await repeat(loops, async () => {
			ctx.registry.replace(scenario.star.rootV1, scenario.star.rootV2)
			ensureOk(await ctx.registry.commit())
			ctx.registry.replace(scenario.star.rootV1, scenario.star.rootV1)
			ensureOk(await ctx.registry.commit())
		})
	})

	stableTask(
		bench,
		cleanups,
		'unregister: leaf cascade (star)',
		() => scenario.setupStarBaseline('bench-star-unreg-leaf'),
		async (ctx) => {
			await repeat(loops, async () => {
				ctx.registry.unregister(scenario.star.hotLeafV1)
				ensureOk(await ctx.registry.commit())
				ctx.registry.register(scenario.star.hotLeafV1)
				ensureOk(await ctx.registry.commit())
			})
		},
	)

	stableTask(
		bench,
		cleanups,
		'unregister: root cascade (star)',
		() => scenario.setupStarBaseline('bench-star-unreg-root'),
		async (ctx) => {
			const effectiveLoops = Math.max(1, Math.floor(loops / 2))
			await repeat(effectiveLoops, async () => {
				ctx.registry.unregister(scenario.star.rootV1)
				ensureOk(await ctx.registry.commit())
				scenario.registerStar(ctx)
				ensureOk(await ctx.registry.commit())
			})
		},
	)

	stableTask(bench, cleanups, 'restart: chain middle (deep)', () => scenario.setupChainBaseline('bench-chain-restart-middle'), async (ctx) => {
		await repeat(loops, async () => {
			ctx.registry.restart(scenario.chain.middle)
			ensureOk(await ctx.registry.commit())
		})
	})

	stableTask(bench, cleanups, 'restart: chain leaf (deep)', () => scenario.setupChainBaseline('bench-chain-restart-leaf'), async (ctx) => {
		await repeat(loops, async () => {
			ctx.registry.restart(scenario.chain.leaf)
			ensureOk(await ctx.registry.commit())
		})
	})

	stableTask(
		bench,
		cleanups,
		'unregister: chain middle cascade (deep)',
		() => scenario.setupChainBaseline('bench-chain-unreg-middle'),
		async (ctx) => {
			const effectiveLoops = Math.max(1, Math.floor(loops / 2))
			await repeat(effectiveLoops, async () => {
				ctx.registry.unregister(scenario.chain.middle)
				ensureOk(await ctx.registry.commit())
				ctx.registry.register(scenario.chain.middle)
				ensureOk(await ctx.registry.commit())
			})
		},
	)

	stableTask(
		bench,
		cleanups,
		'config: inject-heavy restart',
		async () => {
			const ctx = new Context({ name: 'bench-config-heavy' })
			ctx.configService.patchConfig(scenario.configHeavy.id, scenario.configHeavy.record)
			ctx.registry.register(scenario.configHeavy.ctor)
			ensureOk(await ctx.registry.commit())
			return ctx
		},
		async (ctx) => {
			await repeat(loops, async () => {
				ctx.registry.restart(scenario.configHeavy.ctor)
				ensureOk(await ctx.registry.commit())
			})
		},
	)

	// ---------------------------------------------------------------------------
	// Large baselines (many independent plugins) to surface DI/build scaling.
	// ---------------------------------------------------------------------------

	stableTask(bench, cleanups, 'big: noop commit (independent + star)', () => scenario.setupBigStarBaseline('bench-big-noop'), async (ctx) => {
		ensureOk(await ctx.registry.commit())
	})

	stableTask(
		bench,
		cleanups,
		'big: incremental add/remove leaf (independent + star)',
		() => scenario.setupBigStarBaseline('bench-big-add-remove'),
		async (ctx) => {
			await repeat(loops, async () => {
				ctx.registry.register(scenario.star.addLeaf)
				ensureOk(await ctx.registry.commit())
				ctx.registry.unregister(scenario.star.addLeaf, { cascadeDependents: false })
				ensureOk(await ctx.registry.commit())
			})
		},
	)

	stableTask(
		bench,
		cleanups,
		'big: hmr replace leaf (independent + star)',
		() => scenario.setupBigStarBaseline('bench-big-replace-leaf'),
		async (ctx) => {
			await repeat(loops, async () => {
				ctx.registry.replace(scenario.star.hotLeafV1, scenario.star.hotLeafV2)
				ensureOk(await ctx.registry.commit())
				ctx.registry.replace(scenario.star.hotLeafV1, scenario.star.hotLeafV1)
				ensureOk(await ctx.registry.commit())
			})
		},
	)

	stableTask(
		bench,
		cleanups,
		'big: hmr replace root (independent + star)',
		() => scenario.setupBigStarBaseline('bench-big-replace-root'),
		async (ctx) => {
			const effectiveLoops = Math.max(1, Math.floor(loops / 2))
			await repeat(effectiveLoops, async () => {
				ctx.registry.replace(scenario.star.rootV1, scenario.star.rootV2)
				ensureOk(await ctx.registry.commit())
				ctx.registry.replace(scenario.star.rootV1, scenario.star.rootV1)
				ensureOk(await ctx.registry.commit())
			})
		},
	)

	return () => {
		while (cleanups.length) cleanups.pop()?.()
	}
}
