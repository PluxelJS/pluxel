import {
	formatPluginNodeReference,
	pluginNodeAddressOf,
	type CommitSummary,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	requireRuntimePluginGraphCoordinator,
	type PluginExecutionSnapshot,
	type PluginRouteCatalogSnapshot,
} from '@pluxel/runtime/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'

import {
	configureLoaderHmrDefinitionSource,
	LoaderHmrService,
	readLoaderHmrRecentUpdate,
} from '../../src/hmr/engine/LoaderHmrService'
import type { HmrBatchSummary, HmrExecutionResult } from '../../src/hmr/engine/pipeline'
import { requireLoaderService } from '../../src/context-plan'
import { createHmrTestContext } from '../support/hmr-context'
import { lowerTestPlugin } from '../support/lowered-plugin'

const fixedOwner = 'pluxel:fixed:/workspace/pluxel.dynamic.ts'

type LoaderHmrProvenanceHarness = {
	activeModuleFiles(moduleId: string): Iterable<string> | undefined
	recordRecentUpdates(
		summary: HmrBatchSummary,
		catalogBefore: PluginRouteCatalogSnapshot,
		commit: CommitSummary | undefined,
	): void
}

type LoaderHmrBatchHarness = LoaderHmrProvenanceHarness & {
	ensureBaseline(): Promise<void>
	setupBatching(): void
	batchProcessor: {
		process(
			files: string[],
			epoch: number,
			onExecution?: (result: HmrExecutionResult | undefined) => void,
		): Promise<HmrBatchSummary | undefined>
	}
	debouncer: {
		push(moduleId: string): void
		waitForIdle(options: { timeoutMs: number }): Promise<void>
	}
}

type LoaderHmrLifecycleHarness = {
	ensureBaseline(): Promise<void>
	startImpl(): Promise<void>
	waitForWatchersReady(): Promise<void>
	supplementalWatcherReady: Promise<void>
	watcherDisposers: Array<() => void | Promise<void>>
	executor: {
		runAndLoadAll(
			files: readonly string[],
			keepOrder: boolean,
		): Promise<HmrExecutionResult | undefined>
	}
	execLock: {
		run<T>(operation: () => Promise<T>): Promise<T>
	}
}

function successfulExecution(commitSummary?: CommitSummary): HmrExecutionResult {
	return {
		commitResult: { ok: true, val: null },
		...(commitSummary ? { commitSummary } : {}),
		commitMs: 0,
		affectedModules: [],
		syncedModules: [],
	}
}

function executionFor(
	catalog: PluginRouteCatalogSnapshot,
	definition: PluginDefinitionAddress,
): PluginExecutionSnapshot | undefined {
	return catalog.entries.find((entry) => entry.address === definition)?.provenance.execution
}

function summary(
	moduleId: string,
	epoch: number,
	override: Partial<HmrBatchSummary> = {},
): HmrBatchSummary {
	return {
		epoch,
		changed: [moduleId],
		targets: [moduleId],
		affectedModules: [],
		syncedModules: [],
		desiredButStopped: [],
		affected: 1,
		fallbackRoots: 0,
		invalidated: { vite: 1, runner: 1 },
		activeServices: 0,
		plugins: { loaded: 1, desired: 0, running: 0 },
		commitMs: 0,
		batchMs: 2.5,
		ok: true,
		prefetchFailed: 0,
		...override,
	}
}

describe('Loader HMR execution provenance', () => {
	it('classifies source graphs, built entries, every fixed artifact, and unknown graphs honestly', async () => {
		const { ctx } = createHmrTestContext()
		const loader = requireLoaderService(ctx)
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrProvenanceHarness
		harness.activeModuleFiles = (moduleId) => [moduleId]
		const artifactsByExportName = new Map<string, 'source-module' | 'built-module'>([
			['SourceEntry', 'source-module'],
			['BuiltEntry', 'built-module'],
			['FixedSource', 'source-module'],
			['FixedBuilt', 'built-module'],
		])
		const classifyDefinitionArtifact = vi.fn(
			(definition: PluginDefinitionAddress, _activeModules?: Iterable<string>) =>
				artifactsByExportName.get(definition.exportName) ?? ('unreported' as const),
		)
		configureLoaderHmrDefinitionSource(hmr, {
			classifyDefinitionArtifact,
			fixedModules: () => ['/workspace/pluxel.dynamic.ts'],
		})

		@Plugin()
		class SourceEntry extends BasePlugin {}
		lowerTestPlugin(SourceEntry)
		await loader.replaceModule('/workspace/source-entry.ts', { SourceEntry })

		@Plugin()
		class BuiltEntry extends BasePlugin {}
		lowerTestPlugin(BuiltEntry)
		await loader.replaceModule('/workspace/built-entry.mjs', { BuiltEntry })

		harness.activeModuleFiles = () => undefined
		@Plugin()
		class GraphUnavailable extends BasePlugin {}
		lowerTestPlugin(GraphUnavailable)
		await loader.replaceModule('/workspace/graph-unavailable.ts', { GraphUnavailable })

		@Plugin()
		class FixedSource extends BasePlugin {}
		lowerTestPlugin(FixedSource)
		@Plugin()
		class FixedBuilt extends BasePlugin {}
		lowerTestPlugin(FixedBuilt)
		@Plugin()
		class FixedUnreported extends BasePlugin {}
		lowerTestPlugin(FixedUnreported)
		await loader.registerFixedPlugins([FixedSource, FixedBuilt, FixedUnreported], {
			moduleId: fixedOwner,
		})

		const catalog = requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot()
		expect(executionFor(catalog, pluginNodeAddressOf(SourceEntry).definition)).toEqual({
			kind: 'dynamic-entry',
			artifact: { kind: 'source-module' },
			update: { kind: 'definition-hmr', scope: 'source-graph' },
		})
		expect(executionFor(catalog, pluginNodeAddressOf(BuiltEntry).definition)).toEqual({
			kind: 'dynamic-entry',
			artifact: { kind: 'built-module' },
			update: { kind: 'definition-hmr', scope: 'entry-only' },
		})
		expect(executionFor(catalog, pluginNodeAddressOf(GraphUnavailable).definition)).toEqual({
			kind: 'dynamic-entry',
			artifact: { kind: 'unreported' },
			update: { kind: 'definition-hmr', scope: 'entry-only' },
		})
		expect(executionFor(catalog, pluginNodeAddressOf(FixedSource).definition)).toEqual({
			kind: 'dynamic-fixed',
			artifact: { kind: 'source-module' },
			update: { kind: 'host-reload' },
		})
		expect(executionFor(catalog, pluginNodeAddressOf(FixedBuilt).definition)).toEqual({
			kind: 'dynamic-fixed',
			artifact: { kind: 'built-module' },
			update: { kind: 'host-reload' },
		})
		expect(executionFor(catalog, pluginNodeAddressOf(FixedUnreported).definition)).toEqual({
			kind: 'dynamic-fixed',
			artifact: { kind: 'unreported' },
			update: { kind: 'host-reload' },
		})
		for (const entry of catalog.entries) {
			const execution = entry.provenance.execution
			expect(Object.isFrozen(execution)).toBe(true)
			expect(Object.isFrozen(execution?.artifact)).toBe(true)
			expect(Object.isFrozen(execution?.update)).toBe(true)
		}
		expect(classifyDefinitionArtifact).not.toHaveBeenCalledWith(
			pluginNodeAddressOf(GraphUnavailable).definition,
			undefined,
		)
		for (const fixed of [FixedSource, FixedBuilt, FixedUnreported]) {
			expect(classifyDefinitionArtifact).toHaveBeenCalledWith(
				pluginNodeAddressOf(fixed).definition,
				['/workspace/pluxel.dynamic.ts'],
			)
		}
		await hmr.close()
	})

	it('restores the conservative resolver and clears diagnostics when HMR closes', async () => {
		const { ctx } = createHmrTestContext()
		const loader = requireLoaderService(ctx)
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrProvenanceHarness
		harness.activeModuleFiles = (moduleId) => [moduleId]
		configureLoaderHmrDefinitionSource(hmr, {
			classifyDefinitionArtifact: () => 'source-module',
		})
		await hmr.close()

		@Plugin()
		class AfterClose extends BasePlugin {}
		lowerTestPlugin(AfterClose)
		await loader.replaceModule('/workspace/after-close.ts', { AfterClose })
		const address = pluginNodeAddressOf(AfterClose)
		const execution = executionFor(
			requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot(),
			address.definition,
		)
		expect(execution).toEqual({
			kind: 'unreported',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		})
		expect(readLoaderHmrRecentUpdate(hmr, address)).toBeNull()
	})

	it('keeps committed artifact facts and records an issue when diagnostics fail after PONR', async () => {
		const { ctx } = createHmrTestContext()
		const loader = requireLoaderService(ctx)
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrBatchHarness
		const moduleId = '/workspace/post-commit.ts'
		const dependencyModuleId = '/workspace/post-commit-dependency.ts'
		let artifact: 'source-module' | 'built-module' = 'source-module'
		const generationCommit = vi.fn()
		const generationRollback = vi.fn()
		harness.activeModuleFiles = (id) => [id]
		configureLoaderHmrDefinitionSource(hmr, {
			classifyDefinitionArtifact: () => artifact,
			beginArtifactGeneration: () => {
				const previous = artifact
				return {
					run: (operation) => operation(),
					commit: generationCommit,
					rollback: () => {
						generationRollback()
						artifact = previous
					},
				}
			},
		})

		@Plugin()
		class Current extends BasePlugin {}
		lowerTestPlugin(Current, { exportName: 'PostCommitPlugin' })
		await loader.replaceModule(moduleId, { PostCommitPlugin: Current })
		const address = pluginNodeAddressOf(Current)

		harness.ensureBaseline = () => Promise.resolve()
		harness.batchProcessor = {
			process: vi.fn(async (_files, _epoch, onExecution) => {
				artifact = 'built-module'
				await loader.replaceModule(moduleId, { PostCommitPlugin: Current })
				onExecution?.(successfulExecution())
				throw new Error('post-commit diagnostics failed')
			}),
		}
		harness.setupBatching()

		try {
			const observedBatch = hmr.api.waitForBatch({ timeoutMs: 2_000 })
			harness.debouncer.push(dependencyModuleId)
			await harness.debouncer.waitForIdle({ timeoutMs: 2_000 })
			await expect(observedBatch).resolves.toMatchObject({
				epoch: 1,
				ok: false,
				commitError: 'post-commit diagnostics failed',
			})

			expect(generationCommit).toHaveBeenCalledTimes(1)
			expect(generationRollback).not.toHaveBeenCalled()
			expect(artifact).toBe('built-module')
			const catalog = requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot()
			expect(executionFor(catalog, address.definition)).toEqual({
				kind: 'dynamic-entry',
				artifact: { kind: 'built-module' },
				update: { kind: 'definition-hmr', scope: 'entry-only' },
			})
			expect(readLoaderHmrRecentUpdate(hmr, address)).toMatchObject({
				outcome: 'applied-with-issues',
				phase: 'commit',
				sequence: 1,
			})
		} finally {
			await hmr.close()
		}
	})

	it('attributes the exact HMR commit when another runtime mutation commits in-flight', async () => {
		const { ctx } = createHmrTestContext()
		const loader = requireLoaderService(ctx)
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrBatchHarness
		const moduleId = '/workspace/exact-hmr-commit.ts'

		@Plugin()
		class Current extends BasePlugin {}
		lowerTestPlugin(Current, { exportName: 'ExactCommitPlugin' })
		await loader.replaceModule(moduleId, { ExactCommitPlugin: Current })
		const address = pluginNodeAddressOf(Current)
		const slot = requirePluginService(ctx).internNodeAddress(address)

		@Plugin()
		class ConcurrentMutation extends BasePlugin {}
		lowerTestPlugin(ConcurrentMutation)
		const concurrentAddress = pluginNodeAddressOf(ConcurrentMutation)
		const exactCommit: CommitSummary = {
			pluginChanges: {
				added: [],
				replaced: [],
				removed: [],
				restarted: [],
				availabilityChanged: [slot],
			},
			runtimeUpdate: {},
			lifecycleReport: {
				ok: false,
				issues: [
					{
						plugin: slot,
						phase: 'start',
						kind: 'start-failed',
						message: 'exact HMR lifecycle issue',
					},
				],
			},
		}

		harness.ensureBaseline = () => Promise.resolve()
		harness.batchProcessor = {
			process: vi.fn(async (_files, epoch, onExecution) => {
				// This commit occurs while the HMR batch owns its execution lane. A global commit
				// subscriber would capture it and incorrectly report it as the HMR commit.
				await loader.replaceModule('/workspace/concurrent-runtime.ts', { ConcurrentMutation })
				onExecution?.(successfulExecution(exactCommit))
				return summary(moduleId, epoch)
			}),
		}
		harness.setupBatching()

		try {
			const observedBatch = hmr.api.waitForBatch({ timeoutMs: 2_000 })
			harness.debouncer.push(moduleId)
			const batch = await observedBatch
			await harness.debouncer.waitForIdle({ timeoutMs: 2_000 })

			expect(batch.pluginChanges?.availabilityChanged).toEqual([formatPluginNodeReference(address)])
			expect(batch.pluginLifecycleReport).toMatchObject({
				ok: false,
				issues: [
					{ plugin: formatPluginNodeReference(address), message: 'exact HMR lifecycle issue' },
				],
			})
			expect(JSON.stringify(batch.pluginChanges)).not.toContain(
				formatPluginNodeReference(concurrentAddress),
			)
			expect(readLoaderHmrRecentUpdate(hmr, address)).toMatchObject({
				outcome: 'applied-with-issues',
				phase: 'lifecycle',
				sequence: 1,
			})
		} finally {
			await hmr.close()
		}
	})

	it('reports pre-PONR retention separately from post-PONR lifecycle issues', async () => {
		const { ctx } = createHmrTestContext()
		const loader = requireLoaderService(ctx)
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrProvenanceHarness
		const moduleId = '/workspace/recent-update.mjs'

		@Plugin()
		class RecentlyUpdated extends BasePlugin {}
		lowerTestPlugin(RecentlyUpdated)
		await loader.replaceModule(moduleId, { RecentlyUpdated })
		const address = pluginNodeAddressOf(RecentlyUpdated)
		const catalog = requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot()

		harness.recordRecentUpdates(summary(moduleId, 1), catalog, undefined)
		expect(readLoaderHmrRecentUpdate(hmr, address)).toEqual({
			outcome: 'applied',
			phase: null,
			sequence: 1,
			durationMs: 2.5,
		})

		for (const [epoch, phase, failure] of [
			[2, 'evaluate', { executeError: 'evaluation failed' }],
			[3, 'inject', { injectError: 'injection failed' }],
			[4, 'commit', { commitError: 'commit failed' }],
		] as const) {
			harness.recordRecentUpdates(
				summary(moduleId, epoch, { ok: false, ...failure }),
				catalog,
				undefined,
			)
			expect(readLoaderHmrRecentUpdate(hmr, address)).toEqual({
				outcome: 'retained-previous',
				phase,
				sequence: epoch,
				durationMs: 2.5,
			})
		}

		harness.recordRecentUpdates(
			summary(moduleId, 5, { ok: false, commitError: 'post-commit failure' }),
			{ ...catalog, revision: catalog.revision - 1 },
			undefined,
		)
		expect(readLoaderHmrRecentUpdate(hmr, address)).toEqual({
			outcome: 'applied-with-issues',
			phase: 'commit',
			sequence: 5,
			durationMs: 2.5,
		})

		const plugin = requirePluginService(ctx).internNodeAddress(address)
		const lifecycleCommit: CommitSummary = {
			pluginChanges: {
				added: [],
				replaced: [],
				removed: [],
				restarted: [],
				availabilityChanged: [plugin],
			},
			runtimeUpdate: {},
			lifecycleReport: {
				ok: false,
				issues: [
					{
						plugin,
						phase: 'start',
						kind: 'start-failed',
						message: 'fixture lifecycle failure',
					},
				],
			},
		}
		harness.recordRecentUpdates(summary(moduleId, 6), catalog, lifecycleCommit)
		expect(readLoaderHmrRecentUpdate(hmr, address)).toEqual({
			outcome: 'applied-with-issues',
			phase: 'lifecycle',
			sequence: 6,
			durationMs: 2.5,
		})
		expect(JSON.stringify(readLoaderHmrRecentUpdate(hmr, address))).not.toContain(
			'fixture lifecycle failure',
		)

		await hmr.close()
		expect(readLoaderHmrRecentUpdate(hmr, address)).toBeNull()
	})
})

describe('Loader HMR shutdown', () => {
	it('unblocks startup waiting for supplemental watcher readiness when close begins', async () => {
		const { ctx } = createHmrTestContext()
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrLifecycleHarness
		let settleReady = (): void => {}
		harness.supplementalWatcherReady = new Promise<void>((resolve) => {
			settleReady = resolve
		})
		harness.watcherDisposers.push(() => settleReady())
		harness.startImpl = vi.fn(async () => {
			await harness.waitForWatchersReady()
		})

		const startupOutcome = hmr.start().then(
			() => null,
			(error: unknown) => error,
		)
		await Promise.resolve()
		const closing = hmr.close()

		expect(await startupOutcome).toMatchObject({ name: 'HmrClosedError' })
		await closing
	})

	it('waits for in-flight startup before completing shutdown', async () => {
		const { ctx } = createHmrTestContext()
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrLifecycleHarness
		let enterStartup = (): void => {}
		const startupEntered = new Promise<void>((resolve) => {
			enterStartup = resolve
		})
		let releaseStartup = (): void => {}
		const startupGate = new Promise<void>((resolve) => {
			releaseStartup = resolve
		})
		harness.startImpl = vi.fn(async () => {
			enterStartup()
			await startupGate
		})

		const starting = hmr.start()
		await startupEntered
		let closeSettled = false
		const closing = hmr.close().then(() => {
			closeSettled = true
		})
		await Promise.resolve()
		expect(closeSettled).toBe(false)

		releaseStartup()
		await starting
		await closing
		expect(closeSettled).toBe(true)
	})

	it('waits for an active direct execution before disposing route resources', async () => {
		const { ctx } = createHmrTestContext()
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrLifecycleHarness
		let enterExecution = (): void => {}
		const executionEntered = new Promise<void>((resolve) => {
			enterExecution = resolve
		})
		let releaseExecution = (): void => {}
		const executionGate = new Promise<void>((resolve) => {
			releaseExecution = resolve
		})
		harness.ensureBaseline = vi.fn(async () => {})
		harness.executor = {
			runAndLoadAll: vi.fn(async () => {
				enterExecution()
				await executionGate
				return undefined
			}),
		}

		const executing = hmr.executeFiles(['/workspace/active.ts'])
		await executionEntered
		let closeSettled = false
		const closing = hmr.close().then(() => {
			closeSettled = true
		})
		await Promise.resolve()
		expect(closeSettled).toBe(false)

		releaseExecution()
		await executing
		await closing
		expect(closeSettled).toBe(true)
	})

	it('rejects direct work queued across close before touching baseline or executor', async () => {
		const { ctx } = createHmrTestContext()
		const hmr = new LoaderHmrService(ctx, {
			roots: [],
			entries: [],
			fixedModuleId: fixedOwner,
		})
		const harness = hmr as unknown as LoaderHmrLifecycleHarness
		const ensureBaseline = vi.fn(async () => {})
		const runAndLoadAll = vi.fn(async (): Promise<HmrExecutionResult | undefined> => undefined)
		harness.ensureBaseline = ensureBaseline
		harness.executor = { runAndLoadAll }

		let enterLane = (): void => {}
		const laneEntered = new Promise<void>((resolve) => {
			enterLane = resolve
		})
		let releaseLane = (): void => {}
		const laneGate = new Promise<void>((resolve) => {
			releaseLane = resolve
		})
		const held = harness.execLock.run(async () => {
			enterLane()
			await laneGate
		})
		await laneEntered

		const executeOutcome = hmr.executeFiles(['/workspace/queued.ts']).then(
			() => undefined,
			(error: unknown) => error,
		)
		const warmupOutcome = hmr.warmup({ bestEffort: false }).then(
			() => undefined,
			(error: unknown) => error,
		)
		const closing = hmr.close()
		releaseLane()

		expect(await executeOutcome).toMatchObject({ name: 'HmrClosedError' })
		expect(await warmupOutcome).toMatchObject({ name: 'HmrClosedError' })
		await held
		await closing
		expect(ensureBaseline).not.toHaveBeenCalled()
		expect(runAndLoadAll).not.toHaveBeenCalled()
	})
})
