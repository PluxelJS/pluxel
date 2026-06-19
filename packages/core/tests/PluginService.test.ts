import { describe, expect, it } from 'vitest'

import {
	BasePlugin,
	ForkablePlugin,
	Plugin,
	type PluginIdentifier,
	setParamToken,
	withCoreHost,
} from '@pluxel/core/test'
import { PluginB } from './plugins'

function createDeferred() {
	let resolve!: () => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function collectCommitSummaries(host: {
	ctx: { on: (event: 'afterCommit', cb: (summary: unknown) => void) => void }
}) {
	const summaries: unknown[] = []
	host.ctx.on('afterCommit', (summary) => {
		summaries.push(summary)
	})
	return summaries
}

async function waitUntil(cond: () => boolean, opts?: { timeoutMs?: number }) {
	const timeoutMs = opts?.timeoutMs ?? 1_000
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

describe('PluginService commit()', () => {
	it('commits a runtime update transaction', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-COMMIT-A' })
			class A extends BasePlugin {}

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			expect(tx.reason).toBe('hmr')
			tx.register(A)
			const res = await tx.commit({ strict: true })

			expect(res.ok).toBe(true)
			expect(host.ctx.registry.isRunning(A)).toBe(true)
			expect(host.get(A)).toBeInstanceOf(A)
		})
	})

	it('uses runtime plugin keys as graph nodes while keeping constructors as aliases', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'RKEY-A' })
			class A extends BasePlugin {}

			await host.start(A)

			const graph = host.ctx.registry.graph
			expect([...graph.keys()]).toEqual(['RKEY-A'])
			expect(graph.has('RKEY-A')).toBe(true)
			expect(graph.has(A)).toBe(false)
			expect(graph.resolve(A)).toBe('RKEY-A')
			expect(host.get(A)).toBeInstanceOf(A)
		})
	})

	it('does not resolve undecorated constructor names as runtime plugin keys', async () => {
		await withCoreHost(async (host) => {
			class RKEYCollision {}
			const legacyToken = RKEYCollision as unknown as PluginIdentifier

			@Plugin({ name: 'RKEYCollision' })
			class Real extends BasePlugin {}

			await host.start(Real)

			expect(host.ctx.registry.graph.has('RKEYCollision')).toBe(true)
			expect(host.ctx.registry.getInstance(legacyToken)).toBeUndefined()
			expect(host.ctx.registry.isRunning(legacyToken)).toBe(false)
		})
	})

	it('rolls back runtime update draft and pending restarts', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-ROLLBACK-A' })
			class A extends BasePlugin {}

			@Plugin({ name: 'TX-ROLLBACK-B' })
			class B extends BasePlugin {}

			await host.start(A)
			const committedGraph = host.ctx.registry.graph

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.replace(A, B)
			tx.restart(B)
			tx.rollback()

			const summary = await host.commit()
			expect(summary.graph).toBe(committedGraph)
			expect(summary.replaced).toEqual([])
			expect(summary.touched).toEqual([])
			expect(host.ctx.registry.graph.resolve(A)).toBe('TX-ROLLBACK-A')
			expect(host.get(A)).toBeInstanceOf(A)
			expect(host.get(B)).toBeUndefined()
		})
	})

	it('rejects runtime update when a loose draft is already pending', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-PENDING-A' })
			class A extends BasePlugin {}

			host.ctx.registry.register(A)

			expect(() => host.ctx.registry.beginUpdate({ reason: 'hmr' })).toThrow(/pending changes/i)
		})
	})

	it('rejects nested runtime update transactions', async () => {
		await withCoreHost(async (host) => {
			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })

			expect(() => host.ctx.registry.beginUpdate({ reason: 'hmr' })).toThrow(
				/another runtime update is active/i,
			)

			tx.rollback()
		})
	})

	it('rolls back runtime update draft when commit fails', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MISSING-DEP' })
			class MissingDep extends BasePlugin {}

			@Plugin({ name: 'TX-COMMIT-FAIL-CONSUMER' })
			class Consumer extends BasePlugin {
				constructor(public readonly dep: MissingDep) {
					super()
				}
			}
			setParamToken(Consumer, 0, MissingDep)

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.register(Consumer)
			const res = await tx.commit()

			expect(res.ok).toBe(false)
			expect(host.ctx.registry.isRegistered(Consumer)).toBe(false)

			const clean = await host.ctx.registry.commit()
			expect(clean.ok).toBe(true)
			expect(host.ctx.registry.lastCommit?.added).toEqual([])
		})
	})

	it('tracks runtime module ownership inside update transactions', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-A' })
			class A extends BasePlugin {}

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'module-a.ts',
				items: [{ ctor: A, exportKey: 'A' }],
			})
			expect(host.ctx.registry.getRuntimeModuleId(A)).toBe('module-a.ts')
			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-A')).toBe('module-a.ts')
			tx.rollback()

			expect(host.ctx.registry.getRuntimeModuleId(A)).toBeUndefined()
			expect(host.ctx.registry.listRuntimeModuleItems('module-a.ts')).toEqual([])
		})
	})

	it('keeps runtime module ownership after update commit', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-COMMIT-A' })
			class A extends BasePlugin {}

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'module-commit.ts',
				items: [{ ctor: A, exportKey: 'A' }],
			})
			tx.register(A)
			const res = await tx.commit()

			expect(res.ok).toBe(true)
			expect(host.ctx.registry.lastCommit?.reason).toBe('hmr')
			expect(host.ctx.registry.lastCommit?.touchedModules).toEqual(['module-commit.ts'])
			expect(host.ctx.registry.getRuntimeModuleId(A)).toBe('module-commit.ts')
			expect(host.ctx.registry.listRuntimeModuleItems('module-commit.ts')).toEqual([
				{ ctor: A, exportKey: 'A' },
			])
		})
	})

	it('resolves dependency ctor identity drift from runtime module ownership', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-DEP' })
			class Dep extends BasePlugin {}

			@Plugin({ name: 'TX-MODULE-DEP' })
			class DepShadow extends BasePlugin {}

			@Plugin({ name: 'TX-MODULE-CONSUMER' })
			class Consumer extends BasePlugin {
				constructor(readonly dep: DepShadow) {
					super()
				}
			}
			setParamToken(Consumer, 0, DepShadow)

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'dep.ts',
				items: [{ ctor: Dep, exportKey: 'Dep' }],
			})
			tx.upsertModule({
				moduleId: 'consumer.ts',
				items: [{ ctor: Consumer, exportKey: 'Consumer' }],
			})
			tx.register(Dep)
			tx.register(Consumer)
			const res = await tx.commit()

			expect(res.ok).toBe(true)
			expect(host.get(Consumer)?.dep).toBeInstanceOf(Dep)
		})
	})

	it('resolves explicit runtime queries from runtime module ownership', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-QUERY' })
			class Dep extends BasePlugin {}

			@Plugin({ name: 'TX-MODULE-QUERY' })
			class DepShadow extends BasePlugin {}

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'query.ts',
				items: [{ ctor: Dep, exportKey: 'Dep' }],
			})
			tx.register(Dep)
			const commitResult = await tx.commit()
			expect(commitResult.ok).toBe(true)

			expect(host.ctx.registry.isRunning(DepShadow)).toBe(true)
			expect(host.ctx.registry.getInstance(DepShadow)).toBeInstanceOf(Dep)
		})
	})

	it('applies runtime dependency override overlays without mutating constructor metadata', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-OVERRIDE-A' })
			class DepA extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-B' })
			class DepB extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-CONSUMER' })
			class Consumer extends BasePlugin {
				constructor(readonly dep: DepA) {
					super()
				}
			}
			setParamToken(Consumer, 0, DepA)

			host.add([DepA, DepB, Consumer])
			const firstCommit = await host.commit()
			expect(firstCommit.failed).toEqual([])
			expect(host.get(Consumer)?.dep).toBeInstanceOf(DepA)

			host.ctx.registry.setRuntimeDependencyOverrides(Consumer, [DepB])
			const secondCommit = await host.commit()
			expect(secondCommit.failed).toEqual([])

			expect(host.get(Consumer)?.dep).toBeInstanceOf(DepB)
		})
	})

	it('rolls back runtime dependency override overlays with runtime update failure', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-OVERRIDE-ROLLBACK-A' })
			class DepA extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-ROLLBACK-B' })
			class DepB extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-ROLLBACK-C' })
			class DepC extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-ROLLBACK-CONSUMER' })
			class Consumer extends BasePlugin {
				constructor(readonly dep: DepA) {
					super()
				}
			}
			setParamToken(Consumer, 0, DepA)

			host.add([DepA, DepB, DepC, Consumer])
			const initialCommit = await host.commit()
			expect(initialCommit.failed).toEqual([])

			host.ctx.registry.setRuntimeDependencyOverrides(Consumer, [DepB])
			const overrideCommit = await host.commit()
			expect(overrideCommit.failed).toEqual([])
			expect(host.get(Consumer)?.dep).toBeInstanceOf(DepB)

			@Plugin({ name: 'TX-OVERRIDE-ROLLBACK-MISSING' })
			class MissingDep extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-ROLLBACK-BAD' })
			class Bad extends BasePlugin {
				constructor(_dep: MissingDep) {
					super()
				}
			}
			setParamToken(Bad, 0, MissingDep)

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			host.ctx.registry.setRuntimeDependencyOverrides(Consumer, [DepC])
			tx.register(Bad)

			const res = await tx.commit()
			expect(res.ok).toBe(false)

			host.restart(Consumer)
			const restartCommit = await host.commit()
			expect(restartCommit.failed).toEqual([])
			expect(host.get(Consumer)?.dep).toBeInstanceOf(DepB)
		})
	})

	it('applies runtime dependency override overlays by runtime owner name', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-OVERRIDE-NAME-A' })
			class DepA extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-NAME-B' })
			class DepB extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-NAME-CONSUMER' })
			class Consumer extends BasePlugin {
				constructor(readonly dep: DepA) {
					super()
				}
			}
			setParamToken(Consumer, 0, DepA)

			host.add([DepA, DepB, Consumer])
			host.ctx.registry.upsertRuntimeModule({
				moduleId: 'Consumer.ts',
				items: [{ ctor: Consumer, exportKey: 'Consumer' }],
			})
			host.ctx.registry.setRuntimeDependencyOverrides('TX-OVERRIDE-NAME-CONSUMER', [DepB])

			const commit = await host.commit()
			expect(commit.failed).toEqual([])
			expect(host.get(Consumer)?.dep).toBeInstanceOf(DepB)
		})
	})

	it('keeps unrelated runtime dependency override indexes when one index returns to default', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-OVERRIDE-MULTI-A' })
			class DepA extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-MULTI-B' })
			class DepB extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-MULTI-C' })
			class DepC extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-MULTI-D' })
			class DepD extends BasePlugin {}

			@Plugin({ name: 'TX-OVERRIDE-MULTI-CONSUMER' })
			class Consumer extends BasePlugin {
				constructor(
					readonly first: DepA,
					readonly second: DepC,
				) {
					super()
				}
			}
			setParamToken(Consumer, 0, DepA)
			setParamToken(Consumer, 1, DepC)

			host.add([DepA, DepB, DepC, DepD, Consumer])
			const initialCommit = await host.commit()
			expect(initialCommit.failed).toEqual([])

			host.ctx.registry.setRuntimeDependencyOverrides(Consumer, [DepB, DepD])
			const overrideCommit = await host.commit()
			expect(overrideCommit.failed).toEqual([])
			expect(host.get(Consumer)?.first).toBeInstanceOf(DepB)
			expect(host.get(Consumer)?.second).toBeInstanceOf(DepD)

			host.ctx.registry.setRuntimeDependencyOverrides(Consumer, [undefined, DepD])
			const fallbackCommit = await host.commit()
			expect(fallbackCommit.failed).toEqual([])
			expect(host.get(Consumer)?.first).toBeInstanceOf(DepA)
			expect(host.get(Consumer)?.second).toBeInstanceOf(DepD)
		})
	})

	it('resolves fork dependency ctor identity drift from exact runtime module ownership', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-FORK-DEP' })
			class Dep extends ForkablePlugin {}

			@Plugin({ name: 'TX-MODULE-FORK-DEP' })
			class DepShadow extends ForkablePlugin {}

			const DepFork = host.ctx.registry.fork(Dep, 'blue')
			const DepShadowFork = host.ctx.registry.fork(DepShadow, 'blue')

			@Plugin({ name: 'TX-MODULE-FORK-CONSUMER' })
			class Consumer extends BasePlugin {
				constructor(readonly dep: Dep) {
					super()
				}
			}
			setParamToken(Consumer, 0, DepShadowFork)

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'dep-fork.ts',
				items: [{ ctor: DepFork, exportKey: 'DepBlue' }],
			})
			tx.upsertModule({
				moduleId: 'consumer-fork.ts',
				items: [{ ctor: Consumer, exportKey: 'Consumer' }],
			})
			tx.register(DepFork)
			tx.register(Consumer)
			const res = await tx.commit()

			expect(res.ok).toBe(true)
			expect(host.get(Consumer)?.dep).toBeInstanceOf(DepFork)
		})
	})

	it('resolves fork runtime module ownership through the base module', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-FORK-OWNER' })
			class Dep extends ForkablePlugin {}

			const DepFork = host.ctx.registry.fork(Dep, 'blue')

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'dep-fork-owner.ts',
				items: [{ ctor: Dep, exportKey: 'Dep' }],
			})
			tx.register(Dep)
			const res = await tx.commit()
			expect(res.ok).toBe(true)

			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-FORK-OWNER#blue')).toBe(
				'dep-fork-owner.ts',
			)
			expect(host.ctx.registry.getRuntimeModuleId(DepFork)).toBe('dep-fork-owner.ts')
		})
	})

	it('reports touched modules without mutating module ownership', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-TOUCH-A' })
			class A extends BasePlugin {}

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.touchModule('module-touch.ts')
			tx.register(A)
			const res = await tx.commit()

			expect(res.ok).toBe(true)
			expect(host.ctx.registry.lastCommit?.reason).toBe('hmr')
			expect(host.ctx.registry.lastCommit?.touchedModules).toEqual(['module-touch.ts'])
			expect(host.ctx.registry.getRuntimeModuleId(A)).toBeUndefined()
		})
	})

	it('keeps runtime module ctor index when stale module ownership is removed', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-MOVE-A' })
			class A extends BasePlugin {}

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'module-old.ts',
				items: [{ ctor: A, exportKey: 'A' }],
			})
			tx.upsertModule({
				moduleId: 'module-new.ts',
				items: [{ ctor: A, exportKey: 'A' }],
			})
			tx.removeModule('module-old.ts')
			tx.register(A)
			const res = await tx.commit()

			expect(res.ok).toBe(true)
			expect(host.ctx.registry.getRuntimeModuleId(A)).toBe('module-new.ts')
			expect(host.ctx.registry.listRuntimeModuleItems('module-old.ts')).toEqual([])
		})
	})

	it('restores previous runtime module owner when an overlapping update rolls back', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-ROLLBACK-OWNER' })
			class A extends BasePlugin {}

			@Plugin({ name: 'TX-MODULE-ROLLBACK-OWNER' })
			class NextA extends BasePlugin {}

			const seed = host.ctx.registry.beginUpdate({ reason: 'startup' })
			seed.upsertModule({
				moduleId: 'module-a.ts',
				items: [{ ctor: A, exportKey: 'A' }],
			})
			seed.register(A)
			const seedCommit = await seed.commit()
			expect(seedCommit.ok).toBe(true)

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'module-next.ts',
				items: [{ ctor: NextA, exportKey: 'A' }],
			})
			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-ROLLBACK-OWNER')).toBe(
				'module-next.ts',
			)
			tx.rollback()

			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-ROLLBACK-OWNER')).toBe('module-a.ts')
			expect(host.ctx.registry.getRuntimeModuleId(A)).toBe('module-a.ts')
			expect(host.ctx.registry.listRuntimeModuleItems('module-a.ts')).toEqual([
				{ ctor: A, exportKey: 'A' },
			])
			expect(host.ctx.registry.listRuntimeModuleItems('module-next.ts')).toEqual([])
		})
	})

	it('restores the latest previous runtime module owner when multiple modules share an id', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-ROLLBACK-LATEST' })
			class First extends BasePlugin {}

			@Plugin({ name: 'TX-MODULE-ROLLBACK-LATEST' })
			class Second extends BasePlugin {}

			@Plugin({ name: 'TX-MODULE-ROLLBACK-LATEST' })
			class Third extends BasePlugin {}

			const seed = host.ctx.registry.beginUpdate({ reason: 'startup' })
			seed.upsertModule({
				moduleId: 'module-first.ts',
				items: [{ ctor: First, exportKey: 'Plugin' }],
			})
			seed.upsertModule({
				moduleId: 'module-second.ts',
				items: [{ ctor: Second, exportKey: 'Plugin' }],
			})
			const seedCommit = await seed.commit()
			expect(seedCommit.ok).toBe(true)
			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-ROLLBACK-LATEST')).toBe(
				'module-second.ts',
			)

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'module-third.ts',
				items: [{ ctor: Third, exportKey: 'Plugin' }],
			})
			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-ROLLBACK-LATEST')).toBe(
				'module-third.ts',
			)
			tx.rollback()

			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-ROLLBACK-LATEST')).toBe(
				'module-second.ts',
			)
			expect(host.ctx.registry.getRuntimeModuleId(Second)).toBe('module-second.ts')
		})
	})

	it('does not let an older restored snapshot reclaim ownership from a newer module', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'TX-MODULE-ROLLBACK-OLDER' })
			class First extends BasePlugin {}

			@Plugin({ name: 'TX-MODULE-ROLLBACK-OLDER' })
			class Second extends BasePlugin {}

			@Plugin({ name: 'TX-MODULE-ROLLBACK-OLDER' })
			class FirstNext extends BasePlugin {}

			const seed = host.ctx.registry.beginUpdate({ reason: 'startup' })
			seed.upsertModule({
				moduleId: 'module-first.ts',
				items: [{ ctor: First, exportKey: 'Plugin' }],
			})
			seed.upsertModule({
				moduleId: 'module-second.ts',
				items: [{ ctor: Second, exportKey: 'Plugin' }],
			})
			const seedCommit = await seed.commit()
			expect(seedCommit.ok).toBe(true)
			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-ROLLBACK-OLDER')).toBe(
				'module-second.ts',
			)

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'module-first.ts',
				items: [{ ctor: FirstNext, exportKey: 'Plugin' }],
			})
			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-ROLLBACK-OLDER')).toBe(
				'module-first.ts',
			)
			tx.rollback()

			expect(host.ctx.registry.listRuntimeModuleItems('module-first.ts')).toEqual([
				{ ctor: First, exportKey: 'Plugin' },
			])
			expect(host.ctx.registry.getRuntimeModuleId('TX-MODULE-ROLLBACK-OLDER')).toBe(
				'module-second.ts',
			)
			expect(host.ctx.registry.getRuntimeModuleId(Second)).toBe('module-second.ts')
		})
	})

	it('resolves aliases through the committed graph', async () => {
		await withCoreHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'BIND-A' })
			class A extends Abs {}

			await host.start(A, { provideBase: true })
			expect(host.ctx.registry.graph.resolve(Abs)).toBe('BIND-A')
			expect(host.get(Abs)).toBeInstanceOf(A)
		})
	})

	it('replaces a plugin implementation while keeping old tokens resolvable', async () => {
		await withCoreHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'REPL-A' })
			class A extends Abs {}

			@Plugin(Abs, { name: 'REPL-B' })
			class B extends Abs {}

			await host.start(A, { provideBase: true })
			host.replace(A, B, { provideBase: true })
			await host.commit()

			expect(host.ctx.registry.graph.resolve(Abs)).toBe('REPL-B')
			expect(host.ctx.registry.graph.resolve(A)).toBe('REPL-B')
			expect(host.get(Abs)).toBeInstanceOf(B)
			expect(host.get(A)).toBeInstanceOf(B)
			expect(host.get(B)).toBeInstanceOf(B)
		})
	})

	it('reports replacement pairs and touched subtree for root replacement', async () => {
		await withCoreHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'PAIR-A' })
			class A extends Abs {}

			@Plugin(Abs, { name: 'PAIR-B' })
			class B extends Abs {}

			@Plugin({ name: 'PAIR-C' })
			class C extends BasePlugin {
				constructor(public readonly dep: Abs) {
					super()
				}
			}
			setParamToken(C, 0, Abs)

			host.add([A, C], { provideBase: true })
			await host.commit()

			host.replace(A, B, { provideBase: true })
			const summary = await host.commit()

			expect(summary.replaced).toEqual([{ from: 'PAIR-A', to: 'PAIR-B' }])
			expect(new Set(summary.touched)).toEqual(new Set(['PAIR-A', 'PAIR-B', 'PAIR-C']))
			expect(host.ctx.registry.graph.resolve(Abs)).toBe('PAIR-B')
			expect(host.ctx.registry.graph.resolve(A)).toBe('PAIR-B')
			expect(host.get(C)?.dep).toBeInstanceOf(B)
		})
	})

	it('confirms no-op draft commits before publishing the summary graph', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'NOOP-A' })
			class A extends BasePlugin {}

			@Plugin({ name: 'NOOP-B' })
			class B extends BasePlugin {}

			await host.start(A)

			host.replace(A, B)
			host.replace(B, A)

			const summary = await host.commit()
			expect(summary.graph).toBe(host.ctx.registry.graph)
			expect(summary.graph.resolve(A)).toBe('NOOP-A')

			const committedGraph = host.ctx.registry.graph
			const second = await host.commit()
			expect(second.graph).toBe(committedGraph)
			expect(second.added).toEqual([])
			expect(second.removed).toEqual([])
			expect(second.replaced).toEqual([])
			expect(second.failed).toEqual([])
			expect(second.touched).toEqual([])
		})
	})

	it('ready-queue starts dependents without batch barriers', async () => {
		await withCoreHost(
			async (host) => {
				const events: string[] = []

				const aGate = createDeferred()
				const cGate = createDeferred()

				let aStarted = false
				let cStarted = false
				let bStarted = false

				@Plugin({ name: 'RQ-A' })
				class A extends BasePlugin {
					override async init(): Promise<void> {
						aStarted = true
						events.push('A:start')
						await aGate.promise
						events.push('A:done')
					}
				}

				@Plugin({ name: 'RQ-C' })
				class C extends BasePlugin {
					override async init(): Promise<void> {
						cStarted = true
						events.push('C:start')
						await cGate.promise
						events.push('C:done')
					}
				}

				@Plugin({ name: 'RQ-B' })
				class B extends BasePlugin {
					constructor(public a: A) {
						super()
					}

					override init(): void {
						bStarted = true
						events.push('B:init')
					}
				}
				setParamToken(B, 0, A)

				host.add([A, C, B])
				const commitPromise = host.commit()

				await waitUntil(() => aStarted && cStarted)

				aGate.resolve()
				await waitUntil(() => bStarted)
				expect(events).not.toContain('C:done')

				cGate.resolve()
				await commitPromise
			},
			{ registry: { startStrategy: 'ready-queue', startConcurrency: 2 } },
		)
	})

	it('batch strategy keeps depth barriers', async () => {
		await withCoreHost(
			async (host) => {
				const events: string[] = []

				const aGate = createDeferred()
				const cGate = createDeferred()

				let aStarted = false
				let cStarted = false
				let bStarted = false

				@Plugin({ name: 'BATCH-A' })
				class A extends BasePlugin {
					override async init(): Promise<void> {
						aStarted = true
						events.push('A:start')
						await aGate.promise
						events.push('A:done')
					}
				}

				@Plugin({ name: 'BATCH-C' })
				class C extends BasePlugin {
					override async init(): Promise<void> {
						cStarted = true
						events.push('C:start')
						await cGate.promise
						events.push('C:done')
					}
				}

				@Plugin({ name: 'BATCH-B' })
				class B extends BasePlugin {
					constructor(public a: A) {
						super()
					}

					override init(): void {
						bStarted = true
						events.push('B:init')
					}
				}
				setParamToken(B, 0, A)

				host.add([A, C, B])
				const commitPromise = host.commit()

				await waitUntil(() => aStarted && cStarted)

				aGate.resolve()
				await new Promise((resolve) => setTimeout(resolve, 10))
				expect(bStarted).toBe(false)
				expect(events).not.toContain('B:init')

				cGate.resolve()
				await waitUntil(() => bStarted)

				await commitPromise
			},
			{ registry: { startStrategy: 'batch' } },
		)
	})

	it('ready-queue enforces bounded concurrency', async () => {
		await withCoreHost(
			async (host) => {
				let active = 0
				let maxActive = 0
				const unblockers: Array<() => void> = []

				const makeSlow = (name: string) => {
					const gate = createDeferred()
					@Plugin({ name })
					class Slow extends BasePlugin {
						override async init(): Promise<void> {
							active++
							maxActive = Math.max(maxActive, active)
							unblockers.push(gate.resolve)
							try {
								await gate.promise
							} finally {
								active--
							}
						}
					}
					return Slow
				}

				const S1 = makeSlow('S1')
				const S2 = makeSlow('S2')
				const S3 = makeSlow('S3')

				host.add([S1, S2, S3])
				const commitPromise = host.commit()

				await waitUntil(() => active === 2 && unblockers.length === 2)
				expect(maxActive).toBe(2)

				// Free up one slot, third plugin should start.
				unblockers[0]!()
				await waitUntil(() => unblockers.length === 3)
				expect(maxActive).toBe(2)

				// Finish remaining.
				for (const u of unblockers) u()
				await commitPromise
			},
			{ registry: { startStrategy: 'ready-queue', startConcurrency: 2 } },
		)
	})

	it('ready-queue fails fast on dependency chain', async () => {
		await withCoreHost(
			async (host) => {
				let bInit = false
				let cInit = false

				@Plugin({ name: 'FF-A' })
				class A extends BasePlugin {
					override init(): void {
						throw new Error('boom')
					}
				}

				@Plugin({ name: 'FF-B' })
				class B extends BasePlugin {
					constructor(_a: A) {
						super()
					}
					override init(): void {
						bInit = true
					}
				}
				setParamToken(B, 0, A)

				@Plugin({ name: 'FF-C' })
				class C extends BasePlugin {
					constructor(_b: B) {
						super()
					}
					override init(): void {
						cInit = true
					}
				}
				setParamToken(C, 0, B)

				host.add([A, B, C])
				const summary = await host.commitAllowFail()

				expect(summary.failed).toContain('FF-A')
				expect(summary.failed).toContain('FF-B')
				expect(summary.failed).toContain('FF-C')
				expect(bInit).toBe(false)
				expect(cInit).toBe(false)
				expect(host.get(B)).toBeUndefined()
				expect(host.get(C)).toBeUndefined()
			},
			{ registry: { startStrategy: 'ready-queue', startConcurrency: 3 } },
		)
	})

	it('respects global startTimeoutMs when no override is provided', async () => {
		await withCoreHost(
			async (host) => {
				@Plugin({ name: 'TO-global' })
				class Slow extends BasePlugin {
					override async init(signal: AbortSignal): Promise<void> {
						await new Promise<void>((resolve, reject) => {
							const t = setTimeout(resolve, 50)
							signal.addEventListener(
								'abort',
								() => {
									clearTimeout(t)
									reject(new Error('aborted'))
								},
								{ once: true },
							)
						})
					}
				}

				host.add(Slow)
				const summary = await host.commitAllowFail()
				expect(summary.failed).toContain('TO-global')
				expect(host.isRunning(Slow)).toBe(false)
			},
			{ registry: { startTimeoutMs: 10 } },
		)
	})

	it('allows per-plugin startTimeoutMs via @Plugin metadata', async () => {
		await withCoreHost(
			async (host) => {
				@Plugin({ name: 'TO-meta', startTimeoutMs: 200 })
				class Slow extends BasePlugin {
					override async init(signal: AbortSignal): Promise<void> {
						await new Promise<void>((resolve, reject) => {
							const t = setTimeout(resolve, 50)
							signal.addEventListener(
								'abort',
								() => {
									clearTimeout(t)
									reject(new Error('aborted'))
								},
								{ once: true },
							)
						})
					}
				}

				host.add(Slow)
				await host.commit()
				expect(host.isRunning(Slow)).toBe(true)
			},
			{ registry: { startTimeoutMs: 10 } },
		)
	})

	it('can unregister during an active commit and still stop on the next commit', async () => {
		await withCoreHost(async (host) => {
			const summaries: any[] = []
			host.ctx.on('afterCommit', (summary) => {
				summaries.push(summary)
			})

			let stopped = 0

			@Plugin({ name: 'SelfUnloader' })
			class SelfUnloader extends BasePlugin {
				override init(): void {
					void this.ctx.registry.shutdownSelf()
				}

				override stop(): void {
					stopped++
				}
			}

			host.add(SelfUnloader)
			await host.commit()

			await waitUntil(() => summaries.length >= 2)

			expect(stopped).toBe(1)
			expect(host.isRunning(SelfUnloader)).toBe(false)
			expect(host.get(SelfUnloader)).toBeUndefined()
		})
	})

	it('shutdownSelf() throws outside plugin context', async () => {
		await withCoreHost(async (host) => {
			expect(() => host.ctx.registry.shutdownSelf()).toThrow('not in a plugin context')
		})
	})

	it('serializes overlapping commits and preserves plugin state', async () => {
		await withCoreHost(async (host) => {
			const summaries = collectCommitSummaries(host) as Array<{
				added?: unknown[]
			}>

			const slowInit = createDeferred()
			let slowInitCalled = false

			@Plugin({ name: 'SlowPlugin' })
			class SlowPlugin extends BasePlugin {
				override async init(): Promise<void> {
					slowInitCalled = true
					await slowInit.promise
				}
			}

			let firstResolved = false
			let secondResolved = false

			host.add(SlowPlugin)
			const first = host.commit().then((result) => {
				firstResolved = true
				return result
			})

			while (!slowInitCalled) {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}

			host.add(PluginB)
			const second = host.commit().then((result) => {
				secondResolved = true
				return result
			})

			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(firstResolved).toBe(false)
			expect(secondResolved).toBe(false)

			slowInit.resolve()

			const [firstResult, secondResult] = await Promise.all([first, second])

			expect(firstResolved).toBe(true)
			expect(secondResolved).toBe(true)
			expect(firstResult.failed).toEqual([])
			expect(secondResult.failed).toEqual([])

			expect(summaries.length).toBe(2)
			expect(summaries[0]?.added).toEqual(['SlowPlugin'])
			expect(new Set(summaries[1]?.added)).toEqual(new Set(['PluginB']))

			const lastGraph = host.last()?.graph
			expect(lastGraph).toBeDefined()
			expect(lastGraph!.has('SlowPlugin')).toBe(true)
			expect(lastGraph!.has('PluginB')).toBe(true)
		})
	})

	it('captures failing plugins and clears singletons for retries', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'ThrowPlugin' })
			class ThrowPlugin extends BasePlugin {
				override init(): void {
					throw new Error('boom')
				}
			}

			host.add(ThrowPlugin)
			const summary = await host.commitAllowFail()

			expect(summary?.failed).toContain('ThrowPlugin')
			expect(summary?.added).toContain('ThrowPlugin')
			expect(host.get(ThrowPlugin)).toBeUndefined()
		})
	})

	it('retries failed plugins on later commits even without container changes', async () => {
		await withCoreHost(async (host) => {
			let attempt = 0
			const events: string[] = []

			@Plugin({ name: 'Flaky' })
			class Flaky extends BasePlugin {
				override init(): void {
					attempt++
					if (attempt === 1) throw new Error('boom')
					events.push('ok')
				}
			}

			host.add(Flaky)

			await host.commitAllowFail()
			expect(host.last()?.failed).toContain('Flaky')
			expect(host.isRunning(Flaky)).toBe(false)

			// No graph changes, but Flaky should be retried.
			await host.commit()
			expect(host.isRunning(Flaky)).toBe(true)
			expect(events).toEqual(['ok'])
		})
	})

	it('recovers from DI build failures on the next commit', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'MissingDep-B' })
			class B extends BasePlugin {}

			@Plugin({ name: 'MissingDep-A' })
			class A extends BasePlugin {
				constructor(public b: B) {
					super()
				}
			}
			setParamToken(A, 0, B)

			// Draft contains an invalid DI graph: A needs B but B is missing.
			host.add(A)
			await expect(host.commit()).rejects.toThrow(/service verification failed/)
			expect(host.isRunning(A)).toBe(false)
			expect(host.isRunning(B)).toBe(false)

			// Next commit should succeed after registering the missing provider.
			host.add([B, A])
			await host.commit()
			expect(host.isRunning(A)).toBe(true)
			expect(host.isRunning(B)).toBe(true)
		})
	})
})
