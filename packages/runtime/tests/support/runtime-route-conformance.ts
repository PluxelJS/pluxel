import { describe, expect, it } from 'vitest'

import {
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type Context,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import {
	requireRuntimePluginGraphCoordinator,
	requireRuntimeStateStore,
	runtimeStatePatch,
} from '@pluxel/runtime/internal'
import {
	__setPluginConfig,
	__setPluginDefinition,
	PLUGIN_LOWERING_ABI_VERSION,
} from '@pluxel/test/unsafe'

type WorkerGeneration = 'v1' | 'v2'

type WorkerInstance = BasePlugin & {
	readonly generation: WorkerGeneration
	readonly config: Readonly<{ value: string }>
	readonly nodeLabel: string
}

type ConsumerInstance = BasePlugin & {
	readonly injectedGeneration: WorkerGeneration
	readonly injectedNodeLabel: string
}

type WorkerLifecycleEvent = Readonly<{
	generation: WorkerGeneration
	nodeLabel: string
	instance: WorkerInstance
	ctx: Context
}>

export type RuntimeRouteConformanceFixture = Readonly<{
	initialPlugins: readonly PluginConstructor[]
	withoutWorkerPlugins: readonly PluginConstructor[]
	replacementPlugins: readonly PluginConstructor[]
	WorkerV2: PluginConstructor
	addresses: Readonly<{
		stopped: PluginNodeAddress
		worker: PluginNodeAddress
		east: PluginNodeAddress
		west: PluginNodeAddress
		consumer: PluginNodeAddress
	}>
	runtimeState: Readonly<{
		autoStart: readonly PluginNodeAddress[]
		forks: readonly Readonly<{
			definition: PluginNodeAddress['definition']
			forkIds: readonly string[]
		}>[]
		providerDefaults: readonly []
		dependencyOverrides: readonly []
	}>
	configs: readonly Readonly<{
		owner: PluginNodeAddress
		config: Readonly<{ value: string }>
	}>[]
	cleanups: WorkerLifecycleEvent[]
}>

export type RuntimeRouteConformanceHost = Readonly<{
	ctx: Context
	removeWorker(next: RuntimeRouteConformanceFixture): Promise<void>
	replaceWorker(next: RuntimeRouteConformanceFixture): Promise<void>
	dispose(): Promise<void>
}>

export type RuntimeRouteConformanceAdapter = Readonly<{
	name: 'static' | 'dynamic'
	create(fixture: RuntimeRouteConformanceFixture): Promise<RuntimeRouteConformanceHost>
}>

const RouteConfigSchema = {
	'~standard': {
		version: 1 as const,
		vendor: 'pluxel:runtime-route-conformance',
		validate(value: unknown) {
			if (
				value !== null &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				typeof (value as { value?: unknown }).value === 'string'
			) {
				return { value: { value: (value as { value: string }).value } }
			}
			return {
				issues: [{ message: 'Expected an object with a string value', path: ['value'] }],
			}
		},
	},
}

/** Register the same black-box graph contract against one real route catalog adapter. */
export function runtimeRouteConformance(adapter: RuntimeRouteConformanceAdapter): void {
	describe(`${adapter.name} runtime route conformance`, () => {
		it('keeps stopped catalog definitions unmaterialized', async () => {
			const fixture = createFixture()
			const host = await adapter.create(fixture)
			try {
				const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
				const registry = requirePluginService(host.ctx)
				expect(
					coordinator
						.catalogSnapshot()
						.entries.some((entry) =>
							pluginNodeAddressEqual(
								{ definition: entry.address, variant: 'default' },
								fixture.addresses.stopped,
							),
						),
				).toBe(true)
				expect(registry.isMaterialized(fixture.addresses.stopped)).toBe(false)
				expect(registry.isRunning(fixture.addresses.stopped)).toBe(false)
				expect(registry.getInstance(fixture.addresses.stopped)).toBeUndefined()
			} finally {
				await host.dispose()
			}
		})

		it('isolates default and fork generations and removes only the addressed fork', async () => {
			const fixture = createFixture()
			const host = await adapter.create(fixture)
			try {
				const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
				const registry = requirePluginService(host.ctx)
				const initialDefault = requireWorker(host.ctx, fixture.addresses.worker)
				const initialEast = requireWorker(host.ctx, fixture.addresses.east)
				const initialWest = requireWorker(host.ctx, fixture.addresses.west)

				expect(initialDefault.nodeLabel).toBe('default')
				expect(initialEast.nodeLabel).toBe('east')
				expect(initialWest.nodeLabel).toBe('west')
				expect(new Set([initialDefault, initialEast, initialWest]).size).toBe(3)
				expect(new Set([initialDefault.ctx, initialEast.ctx, initialWest.ctx]).size).toBe(3)

				await coordinator.updateRuntimeState(
					runtimeStatePatch(
						{ type: 'set-auto-start', node: fixture.addresses.east, autoStart: false },
						{
							type: 'remove-fork',
							definition: fixture.addresses.worker.definition,
							forkId: 'east',
						},
					),
				)

				expect(registry.isMaterialized(fixture.addresses.east)).toBe(false)
				expect(registry.isRunning(fixture.addresses.east)).toBe(false)
				expect(registry.getInstance(fixture.addresses.east)).toBeUndefined()
				expect(registry.getInstance(fixture.addresses.worker)).toBe(initialDefault)
				expect(registry.getInstance(fixture.addresses.west)).toBe(initialWest)
				expect(registry.isRunning(fixture.addresses.worker)).toBe(true)
				expect(registry.isRunning(fixture.addresses.west)).toBe(true)
				expect(fixture.cleanups.map((event) => event.instance)).toEqual([initialEast])
			} finally {
				await host.dispose()
			}
		})

		it('restarts one address and replaces all materialized generations at one definition', async () => {
			const fixture = createFixture()
			const host = await adapter.create(fixture)
			try {
				const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
				const registry = requirePluginService(host.ctx)
				const firstDefault = requireWorker(host.ctx, fixture.addresses.worker)
				const firstEast = requireWorker(host.ctx, fixture.addresses.east)
				const firstWest = requireWorker(host.ctx, fixture.addresses.west)

				await coordinator.restartNode(fixture.addresses.east)
				const restartedEast = requireWorker(host.ctx, fixture.addresses.east)
				expect(restartedEast).not.toBe(firstEast)
				expect(restartedEast.ctx).not.toBe(firstEast.ctx)
				expect(restartedEast.nodeLabel).toBe('east')
				expect(registry.getInstance(fixture.addresses.worker)).toBe(firstDefault)
				expect(registry.getInstance(fixture.addresses.west)).toBe(firstWest)

				await host.replaceWorker(fixture)
				const nextDefault = requireWorker(host.ctx, fixture.addresses.worker)
				const nextEast = requireWorker(host.ctx, fixture.addresses.east)
				const nextWest = requireWorker(host.ctx, fixture.addresses.west)
				for (const [instance, label] of [
					[nextDefault, 'default'],
					[nextEast, 'east'],
					[nextWest, 'west'],
				] as const) {
					expect(instance).toBeInstanceOf(fixture.WorkerV2)
					expect(instance.generation).toBe('v2')
					expect(instance.nodeLabel).toBe(label)
				}
				expect(nextDefault.ctx).not.toBe(firstDefault.ctx)
				expect(nextEast.ctx).not.toBe(restartedEast.ctx)
				expect(nextWest.ctx).not.toBe(firstWest.ctx)
				expect(fixture.cleanups.map((event) => event.instance)).toEqual(
					expect.arrayContaining([firstDefault, firstEast, restartedEast, firstWest]),
				)
				expect(
					coordinator
						.catalogSnapshot()
						.entries.find((entry) =>
							pluginNodeAddressEqual(
								{ definition: entry.address, variant: 'default' },
								fixture.addresses.worker,
							),
						)?.candidate.implementation,
				).toBe(fixture.WorkerV2)
			} finally {
				await host.dispose()
			}
		})

		it('preserves an explicit fork binding across provider definition replacement', async () => {
			const fixture = createFixture()
			const host = await adapter.create(fixture)
			try {
				const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
				const registry = requirePluginService(host.ctx)
				const firstConsumer = requireConsumer(host.ctx, fixture.addresses.consumer)
				expect(firstConsumer.injectedNodeLabel).toBe('default')

				await coordinator.updateRuntimeState(
					runtimeStatePatch({
						type: 'set-dependency-override',
						consumer: fixture.addresses.consumer,
						requirement: fixture.addresses.worker.definition,
						provider: fixture.addresses.east,
					}),
				)
				const boundConsumer = requireConsumer(host.ctx, fixture.addresses.consumer)
				expect(boundConsumer).not.toBe(firstConsumer)
				expect(boundConsumer.injectedNodeLabel).toBe('east')
				expect(boundConsumer.injectedGeneration).toBe('v1')
				expect(registry.resolvedDependencies(fixture.addresses.consumer)).toHaveLength(1)
				expect(
					pluginNodeAddressEqual(
						registry.resolvedDependencies(fixture.addresses.consumer)[0]!,
						fixture.addresses.east,
					),
				).toBe(true)
				expect(requireRuntimeStateStore(host.ctx).snapshot().dependencyOverrides).toContainEqual({
					consumerAddress: fixture.addresses.consumer,
					requirementAddress: fixture.addresses.worker.definition,
					providerAddress: fixture.addresses.east,
				})

				await host.replaceWorker(fixture)
				const replacedConsumer = requireConsumer(host.ctx, fixture.addresses.consumer)
				expect(replacedConsumer).not.toBe(boundConsumer)
				expect(replacedConsumer.injectedNodeLabel).toBe('east')
				expect(replacedConsumer.injectedGeneration).toBe('v2')
				expect(registry.resolvedDependencies(fixture.addresses.consumer)).toHaveLength(1)
				expect(
					pluginNodeAddressEqual(
						registry.resolvedDependencies(fixture.addresses.consumer)[0]!,
						fixture.addresses.east,
					),
				).toBe(true)
				expect(registry.isRunning(fixture.addresses.east)).toBe(true)
				expect(requireRuntimeStateStore(host.ctx).snapshot().dependencyOverrides).toContainEqual({
					consumerAddress: fixture.addresses.consumer,
					requirementAddress: fixture.addresses.worker.definition,
					providerAddress: fixture.addresses.east,
				})
			} finally {
				await host.dispose()
			}
		})

		it('preserves durable intent across source removal and restores every addressed node', async () => {
			const fixture = createFixture()
			const host = await adapter.create(fixture)
			try {
				const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
				const state = requireRuntimeStateStore(host.ctx)
				const registry = requirePluginService(host.ctx)

				await host.removeWorker(fixture)
				for (const address of [
					fixture.addresses.worker,
					fixture.addresses.east,
					fixture.addresses.west,
					fixture.addresses.consumer,
				]) {
					expect(registry.isMaterialized(address)).toBe(false)
					expect(registry.isRunning(address)).toBe(false)
				}
				const retainedState = state.snapshot()
				expect(retainedState.autoStart).toHaveLength(fixture.runtimeState.autoStart.length)
				for (const address of fixture.runtimeState.autoStart) {
					expect(
						retainedState.autoStart.some((candidate) => pluginNodeAddressEqual(candidate, address)),
					).toBe(true)
				}
				expect(retainedState.forks).toEqual(fixture.runtimeState.forks)
				for (const address of [
					fixture.addresses.worker,
					fixture.addresses.east,
					fixture.addresses.west,
				]) {
					expect(
						coordinator
							.reconciliationIssues()
							.some(
								(issue) =>
									issue.kind === 'consumer_unavailable' &&
									pluginNodeAddressEqual(issue.consumer, address),
							),
					).toBe(true)
				}

				await host.replaceWorker(fixture)
				for (const address of [
					fixture.addresses.worker,
					fixture.addresses.east,
					fixture.addresses.west,
					fixture.addresses.consumer,
				]) {
					expect(registry.isRunning(address)).toBe(true)
				}
				expect(requireWorker(host.ctx, fixture.addresses.worker).generation).toBe('v2')
				expect(requireWorker(host.ctx, fixture.addresses.east).generation).toBe('v2')
				expect(requireWorker(host.ctx, fixture.addresses.west).generation).toBe('v2')
				expect(requireConsumer(host.ctx, fixture.addresses.consumer).injectedGeneration).toBe('v2')
				expect(coordinator.reconciliationIssues()).toEqual([])
			} finally {
				await host.dispose()
			}
		})
	})
}

function createFixture(): RuntimeRouteConformanceFixture {
	const cleanups: WorkerLifecycleEvent[] = []

	abstract class WorkerBase extends BasePlugin {
		abstract readonly generation: WorkerGeneration
		// Explicit unsafe lowering below owns this local schema; no source transform is intended.
		// oxlint-disable-next-line pluxel/configs-use-top-level-class
		readonly config = this.configs.use(RouteConfigSchema) as Readonly<{ value: string }>
		nodeLabel = 'uninitialized'

		override init(): () => void {
			this.nodeLabel = this.config.value
			const event: WorkerLifecycleEvent = {
				generation: this.generation,
				nodeLabel: this.nodeLabel,
				instance: this,
				ctx: this.ctx,
			}
			return () => cleanups.push(event)
		}
	}

	class WorkerV1 extends WorkerBase {
		readonly generation = 'v1' as const
	}

	class WorkerV2 extends WorkerBase {
		readonly generation = 'v2' as const
	}

	class Consumer extends BasePlugin {
		injectedGeneration!: WorkerGeneration
		injectedNodeLabel!: string

		constructor(readonly dependency: WorkerBase) {
			super()
		}

		override init(): void {
			this.injectedGeneration = this.dependency.generation
			this.injectedNodeLabel = this.dependency.nodeLabel
		}
	}

	class Stopped extends BasePlugin {}

	Plugin({ displayName: 'Route Worker', forkable: true })(WorkerV1)
	Plugin({ displayName: 'Route Worker v2', forkable: true })(WorkerV2)
	Plugin({ displayName: 'Route Consumer' })(Consumer)
	Plugin({ displayName: 'Route Stopped' })(Stopped)

	const workerDefinition = definitionAddress('Worker')
	setDefinition(WorkerV1, workerDefinition)
	setDefinition(WorkerV2, workerDefinition)
	setDefinition(Consumer, definitionAddress('Consumer'), [workerDefinition])
	setDefinition(Stopped, definitionAddress('Stopped'))
	for (const Worker of [WorkerV1, WorkerV2]) {
		__setPluginConfig(Worker, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			fieldName: 'config',
			schema: RouteConfigSchema,
		})
	}

	const worker = pluginNodeAddressOf(WorkerV1)
	const east = forkAddress(worker, 'east')
	const west = forkAddress(worker, 'west')
	const consumer = pluginNodeAddressOf(Consumer)
	const stopped = pluginNodeAddressOf(Stopped)
	return {
		initialPlugins: Object.freeze([Stopped, WorkerV1, Consumer]),
		withoutWorkerPlugins: Object.freeze([Stopped, Consumer]),
		replacementPlugins: Object.freeze([Stopped, WorkerV2, Consumer]),
		WorkerV2,
		addresses: Object.freeze({ stopped, worker, east, west, consumer }),
		runtimeState: Object.freeze({
			autoStart: Object.freeze([worker, east, west, consumer]),
			forks: Object.freeze([
				Object.freeze({
					definition: worker.definition,
					forkIds: Object.freeze(['east', 'west']),
				}),
			]),
			providerDefaults: Object.freeze([]) as readonly [],
			dependencyOverrides: Object.freeze([]) as readonly [],
		}),
		configs: Object.freeze([
			Object.freeze({ owner: worker, config: Object.freeze({ value: 'default' }) }),
			Object.freeze({ owner: east, config: Object.freeze({ value: 'east' }) }),
			Object.freeze({ owner: west, config: Object.freeze({ value: 'west' }) }),
		]),
		cleanups,
	}
}

function definitionAddress(exportName: string): PluginNodeAddress['definition'] {
	return {
		entry: {
			kind: 'source-entry',
			sourceSpace: 'app',
			path: `tests/runtime-route-conformance/${exportName}.ts`,
		},
		exportName,
	}
}

function setDefinition(
	implementation: PluginConstructor,
	definition: PluginNodeAddress['definition'],
	requires: readonly PluginNodeAddress['definition'][] = [],
): void {
	__setPluginDefinition(implementation, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition,
		constructorRequires: requires,
	})
}

function forkAddress(worker: PluginNodeAddress, forkId: string): PluginNodeAddress {
	return { definition: worker.definition, variant: 'fork', forkId }
}

function requireWorker(ctx: Context, address: PluginNodeAddress): WorkerInstance {
	const instance = requirePluginService(ctx).getInstance(address)
	expect(instance, `expected running worker ${address.variant}`).toBeDefined()
	return instance as WorkerInstance
}

function requireConsumer(ctx: Context, address: PluginNodeAddress): ConsumerInstance {
	const instance = requirePluginService(ctx).getInstance(address)
	expect(instance, 'expected running route consumer').toBeDefined()
	return instance as ConsumerInstance
}
