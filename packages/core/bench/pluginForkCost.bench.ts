import {
	BasePlugin,
	Plugin,
	pluginNodeAddressOf,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	consumePluginDefinitionCandidate,
	createCoreRootContext,
	requirePluginService,
	type ConcretePluginDefinitionCandidate,
} from '@pluxel/core/internal'
import { __setPluginDefinition } from '@pluxel/core/toolchain'

const sizes = [1, 10, 100, 1_000] as const
const queryTargetOperations = 20_000
const providerStateBytes = Number(process.env.PLUXEL_FORK_BENCH_PROVIDER_BYTES ?? 128)

if (!Number.isSafeInteger(providerStateBytes) || providerStateBytes < 0) {
	throw new RangeError('PLUXEL_FORK_BENCH_PROVIDER_BYTES must be a non-negative safe integer')
}

const definition = Object.freeze({
	entry: Object.freeze({
		kind: 'source-entry' as const,
		sourceSpace: 'app',
		path: 'core-bench/plugin-fork-cost/provider',
	}),
	exportName: 'ForkCostProvider',
}) satisfies PluginDefinitionAddress

let constructedGenerations = 0

// The benchmark uses imperative lowering because Node's strip-only runner cannot parse decorators.
// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration
class ForkCostProviderV1 extends BasePlugin {
	readonly ownedState = new Uint8Array(providerStateBytes)

	constructor() {
		super()
		constructedGenerations += 1
	}
}

// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration
class ForkCostProviderV2 extends BasePlugin {
	readonly ownedState = new Uint8Array(providerStateBytes)

	constructor() {
		super()
		constructedGenerations += 1
	}
}

for (const implementation of [ForkCostProviderV1, ForkCostProviderV2]) {
	Plugin({ forkable: true })(implementation)
	__setPluginDefinition(implementation, {
		abiVersion: 2,
		kind: 'plugin',
		definition,
	})
}

const candidateV1 = consumePluginDefinitionCandidate(ForkCostProviderV1)
const candidateV2 = consumePluginDefinitionCandidate(ForkCostProviderV2)

function createIndependent(index: number): {
	address: PluginNodeAddress
	candidate: ConcretePluginDefinitionCandidate
} {
	class Independent extends BasePlugin {}
	const independentDefinition = Object.freeze({
		entry: Object.freeze({
			kind: 'source-entry' as const,
			sourceSpace: 'app',
			path: `core-bench/plugin-fork-cost/background-${index}`,
		}),
		exportName: `Background${index}`,
	}) satisfies PluginDefinitionAddress
	Plugin()(Independent)
	__setPluginDefinition(Independent, {
		abiVersion: 2,
		kind: 'plugin',
		definition: independentDefinition,
	})
	return {
		address: pluginNodeAddressOf(Independent),
		candidate: consumePluginDefinitionCandidate(Independent),
	}
}

const backgroundNodes = Array.from({ length: 1_000 }, (_, index) => createIndependent(index))

function forkAddress(index: number): PluginNodeAddress {
	return Object.freeze({
		definition,
		variant: 'fork' as const,
		forkId: `fork-${index}`,
	})
}

type MemorySnapshot = Readonly<{
	heapUsed: number
	arrayBuffers: number
}>

function memorySnapshot(): MemorySnapshot {
	if (!globalThis.gc) throw new Error('Run the fork cost benchmark with node --expose-gc')
	globalThis.gc()
	globalThis.gc()
	const usage = process.memoryUsage()
	return Object.freeze({ heapUsed: usage.heapUsed, arrayBuffers: usage.arrayBuffers })
}

const deltaKiB = (after: number, before: number): number => (after - before) / 1_024

function elapsedMs(run: () => void): number {
	const started = performance.now()
	run()
	return performance.now() - started
}

async function elapsedAsyncMs(run: () => Promise<void>): Promise<number> {
	const started = performance.now()
	await run()
	return performance.now() - started
}

function requireOk(result: { ok: boolean; err?: unknown }) {
	if (!result.ok) throw result.err
}

type DefinitionInternals = {
	createPluginContext: () => Context
	definitions: Map<unknown, unknown>
	nodes: Map<unknown, { definition: unknown }>
	nodesByDefinition: Map<unknown, ReadonlySet<unknown>>
	pendingDefinitions: Map<unknown, unknown>
	pendingNodes: Map<unknown, unknown>
	draft: {
		preview(): {
			ok: boolean
			val?: { graph: { slotCount(): number; activeCount(): number } }
		}
	}
	slots: {
		lookupDefinition(address: PluginDefinitionAddress): object | undefined
		forkNodes: WeakMap<object, Map<string, unknown>>
	}
	lastGraph: { slotCount(): number; activeCount(): number }
}

type Registry = ReturnType<typeof requirePluginService>

function internalsOf(registry: object): DefinitionInternals {
	return (registry as { definitions: DefinitionInternals }).definitions
}

async function prepareAndCommitForks(
	registry: Registry,
	internals: DefinitionInternals,
	addresses: readonly PluginNodeAddress[],
): Promise<{
	prepareMs: number
	commitMs: number
	preparedMemory: MemorySnapshot
	preparedDefinitions: number
	preparedNodes: number
	preparedGraphSlots: number
	preparedGraphActive: number
}> {
	const update = registry.beginUpdate({ reason: `fork-cost-add-${addresses.length}` })
	const prepareMs = elapsedMs(() => {
		for (const address of addresses) update.materializeNode(address, candidateV1)
		update.prepare()
	})
	const preview = internals.draft.preview()
	if (!preview.ok || !preview.val) throw new Error('Prepared fork graph preview is unavailable')
	const preparedDefinitions = internals.pendingDefinitions.size
	const preparedNodes = internals.pendingNodes.size
	const preparedGraphSlots = preview.val.graph.slotCount()
	const preparedGraphActive = preview.val.graph.activeCount()
	const preparedMemory = memorySnapshot()
	const commitMs = await elapsedAsyncMs(async () => {
		requireOk(await update.commit())
	})
	return {
		prepareMs,
		commitMs,
		preparedMemory,
		preparedDefinitions,
		preparedNodes,
		preparedGraphSlots,
		preparedGraphActive,
	}
}

function providerResourceFacts(
	registry: Registry,
	addresses: readonly PluginNodeAddress[],
): { arrayBuffers: number; payloadBytes: number } {
	const buffers = new Set<ArrayBufferLike>()
	let payloadBytes = 0
	for (const address of addresses) {
		const instance = registry.getInstance(address)
		if (!(instance instanceof ForkCostProviderV1)) {
			throw new Error('Initial fork generation does not use the expected provider implementation')
		}
		buffers.add(instance.ownedState.buffer)
		payloadBytes += instance.ownedState.byteLength
	}
	return { arrayBuffers: buffers.size, payloadBytes }
}

type Row = {
	forks: number
	absentQueryUs: number
	materializeMs: number
	prepareMs: number
	commitMs: number
	replaceMs: number
	removeMs: number
	disposeMs: number
	preparedHeapDeltaKiB: number
	commitHeapDeltaKiB: number
	materializedHeapKiB: number
	removedHeapKiB: number
	postDisposeHeapKiB: number
	preparedArrayBuffersDeltaKiB: number
	commitArrayBuffersDeltaKiB: number
	materializedArrayBuffersKiB: number
	removedArrayBuffersKiB: number
	postDisposeArrayBuffersKiB: number
	nominalProviderBytes: number
	providerArrayBuffers: number
	providerOwnedPayloadBytes: number
	preparedDefinitions: number
	preparedNodes: number
	preparedGraphSlots: number
	preparedGraphActive: number
	initialGenerationContexts: number
	constructedGenerations: number
	recordsAfterAdd: number
	recordsAfterRemove: number
	activeAfterRemove: number
	retainedGraphSlots: number
	retainedIdentityTombstones: number
}

async function runHost(
	forks: number,
): Promise<Omit<Row, 'postDisposeHeapKiB' | 'postDisposeArrayBuffersKiB'>> {
	const ctx = createCoreRootContext({ name: `fork-cost-${forks}` })
	const registry = requirePluginService(ctx)
	const internals = internalsOf(registry)
	const originalCreatePluginContext = internals.createPluginContext
	let generationContexts = 0
	internals.createPluginContext = () => {
		generationContexts += 1
		return originalCreatePluginContext()
	}
	const addresses = Array.from({ length: forks }, (_, index) => forkAddress(index))
	const hostBaselineMemory = memorySnapshot()

	const queryRounds = Math.max(1, Math.ceil(queryTargetOperations / forks))
	let querySink = 0
	const queryMs = elapsedMs(() => {
		for (let round = 0; round < queryRounds; round++) {
			for (const address of addresses) {
				if (registry.isMaterialized(address)) querySink += 1
				if (registry.isRunning(address)) querySink += 1
				if (registry.getInstance(address)) querySink += 1
				if (registry.resolvePluginNode(address)) querySink += 1
			}
		}
	})
	if (querySink !== 0) throw new Error('Absent fork projection unexpectedly resolved')
	if (
		internals.definitions.size > 0 ||
		internals.nodes.size > 0 ||
		internals.lastGraph.slotCount() !== 0 ||
		generationContexts !== 0
	) {
		throw new Error('Absent fork projection allocated Core runtime state')
	}

	const prepared = await prepareAndCommitForks(registry, internals, addresses)
	const {
		prepareMs,
		commitMs,
		preparedMemory,
		preparedDefinitions,
		preparedNodes,
		preparedGraphSlots,
		preparedGraphActive,
	} = prepared
	const materializeMs = prepareMs + commitMs
	const materializedMemory = memorySnapshot()
	const initialGenerationContexts = generationContexts
	const providerResources = providerResourceFacts(registry, addresses)
	const recordsAfterAdd = internals.nodes.size
	const definitionRecords = new Set(
		[...internals.nodes.values()].map((record) => record.definition),
	)
	if (
		internals.definitions.size !== 1 ||
		recordsAfterAdd !== forks ||
		definitionRecords.size !== 1 ||
		preparedDefinitions !== 1 ||
		preparedNodes !== forks ||
		preparedGraphSlots !== forks ||
		preparedGraphActive !== forks ||
		initialGenerationContexts !== forks ||
		providerResources.arrayBuffers !== forks ||
		providerResources.payloadBytes !== forks * providerStateBytes
	) {
		throw new Error('Materialized forks did not share one definition record or one generation each')
	}

	const replaceMs = await elapsedAsyncMs(async () => {
		const update = registry.beginUpdate({ reason: `fork-cost-replace-${forks}` })
		update.replaceDefinition(definition, candidateV2, { cascadeDependents: false })
		requireOk(await update.commit())
	})
	if (generationContexts !== forks * 2) {
		throw new Error('Definition replacement did not construct exactly k new generations')
	}

	const removeMs = await elapsedAsyncMs(async () => {
		const update = registry.beginUpdate({ reason: `fork-cost-remove-${forks}` })
		for (const address of addresses) update.dematerializeNode(address, { cascadeDependents: false })
		requireOk(await update.commit())
	})
	const removedMemory = memorySnapshot()
	const definitionSlot = internals.slots.lookupDefinition(definition)
	const retainedIdentityTombstones = definitionSlot
		? (internals.slots.forkNodes.get(definitionSlot)?.size ?? 0)
		: 0
	if (
		internals.definitions.size > 0 ||
		internals.nodes.size > 0 ||
		internals.lastGraph.activeCount() !== 0
	) {
		throw new Error('Fork removal retained records or active graph generations')
	}

	const disposeMs = await elapsedAsyncMs(async () => {
		await ctx.effects.dispose()
	})

	return {
		forks,
		absentQueryUs: (queryMs * 1_000) / (queryRounds * forks * 4),
		materializeMs,
		prepareMs,
		commitMs,
		replaceMs,
		removeMs,
		disposeMs,
		preparedHeapDeltaKiB: deltaKiB(preparedMemory.heapUsed, hostBaselineMemory.heapUsed),
		commitHeapDeltaKiB: deltaKiB(materializedMemory.heapUsed, preparedMemory.heapUsed),
		materializedHeapKiB: deltaKiB(materializedMemory.heapUsed, hostBaselineMemory.heapUsed),
		removedHeapKiB: deltaKiB(removedMemory.heapUsed, hostBaselineMemory.heapUsed),
		preparedArrayBuffersDeltaKiB: deltaKiB(
			preparedMemory.arrayBuffers,
			hostBaselineMemory.arrayBuffers,
		),
		commitArrayBuffersDeltaKiB: deltaKiB(
			materializedMemory.arrayBuffers,
			preparedMemory.arrayBuffers,
		),
		materializedArrayBuffersKiB: deltaKiB(
			materializedMemory.arrayBuffers,
			hostBaselineMemory.arrayBuffers,
		),
		removedArrayBuffersKiB: deltaKiB(removedMemory.arrayBuffers, hostBaselineMemory.arrayBuffers),
		nominalProviderBytes: forks * providerStateBytes,
		providerArrayBuffers: providerResources.arrayBuffers,
		providerOwnedPayloadBytes: providerResources.payloadBytes,
		preparedDefinitions,
		preparedNodes,
		preparedGraphSlots,
		preparedGraphActive,
		initialGenerationContexts,
		constructedGenerations,
		recordsAfterAdd,
		recordsAfterRemove: internals.nodes.size,
		activeAfterRemove: internals.lastGraph.activeCount(),
		retainedGraphSlots: internals.lastGraph.slotCount(),
		retainedIdentityTombstones,
	}
}

async function runSize(forks: number): Promise<Row> {
	constructedGenerations = 0
	const beforeHostMemory = memorySnapshot()
	const row = await runHost(forks)
	const postDisposeMemory = memorySnapshot()
	return {
		...row,
		postDisposeHeapKiB: deltaKiB(postDisposeMemory.heapUsed, beforeHostMemory.heapUsed),
		postDisposeArrayBuffersKiB: deltaKiB(
			postDisposeMemory.arrayBuffers,
			beforeHostMemory.arrayBuffers,
		),
	}
}

async function fixedFamilyReplacement(background: number) {
	const ctx = createCoreRootContext({ name: `fork-cost-background-${background}` })
	const registry = requirePluginService(ctx)
	const target = pluginNodeAddressOf(ForkCostProviderV1)
	const initial = registry.beginUpdate({ reason: `fixed-family-setup-${background}` })
	initial.materializeNode(target, candidateV1)
	for (let index = 0; index < background; index++) {
		const node = backgroundNodes[index]!
		initial.materializeNode(node.address, node.candidate)
	}
	requireOk(await initial.commit())

	const samples: number[] = []
	const iterations = background >= 1_000 ? 6 : 12
	for (let iteration = 0; iteration <= iterations; iteration++) {
		const candidate = iteration % 2 === 0 ? candidateV2 : candidateV1
		const elapsed = await elapsedAsyncMs(async () => {
			const update = registry.beginUpdate({ reason: `fixed-family-replace-${background}` })
			update.replaceDefinition(definition, candidate, { cascadeDependents: false })
			requireOk(await update.commit())
		})
		if (iteration > 0) samples.push(elapsed)
	}

	const shutdown = registry.beginUpdate({ reason: `fixed-family-shutdown-${background}` })
	shutdown.dematerializeNode(target, { cascadeDependents: false })
	for (let index = 0; index < background; index++) {
		shutdown.dematerializeNode(backgroundNodes[index]!.address, { cascadeDependents: false })
	}
	requireOk(await shutdown.commit())
	await ctx.effects.dispose()
	return {
		background,
		meanMs: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
		minMs: Math.min(...samples),
		maxMs: Math.max(...samples),
	}
}

const rows: Row[] = []
for (const size of sizes) rows.push(await runSize(size))
const fixedFamilyRows = []
for (const background of sizes) fixedFamilyRows.push(await fixedFamilyReplacement(background))

console.log('Definition-family timings')
console.table(
	rows.map((row) => ({
		'Variants k': row.forks,
		'Absent us/query': row.absentQueryUs.toFixed(3),
		'Prepare ms': row.prepareMs.toFixed(3),
		'Commit/start ms': row.commitMs.toFixed(3),
		'Add+start ms': row.materializeMs.toFixed(3),
		'k-variant replace ms': row.replaceMs.toFixed(3),
		'Remove ms': row.removeMs.toFixed(3),
		'Dispose ms': row.disposeMs.toFixed(3),
	})),
)
console.log('Measured memory deltas')
console.table(
	rows.map((row) => ({
		'Variants k': row.forks,
		'Prepared heap Δ KiB': row.preparedHeapDeltaKiB.toFixed(1),
		'Commit heap Δ KiB': row.commitHeapDeltaKiB.toFixed(1),
		'Live heap Δ KiB': row.materializedHeapKiB.toFixed(1),
		'Removed heap Δ KiB': row.removedHeapKiB.toFixed(1),
		'Post-dispose heap Δ KiB': row.postDisposeHeapKiB.toFixed(1),
		'Prepared ArrayBuffers Δ KiB': row.preparedArrayBuffersDeltaKiB.toFixed(1),
		'Commit ArrayBuffers Δ KiB': row.commitArrayBuffersDeltaKiB.toFixed(1),
		'Live ArrayBuffers Δ KiB': row.materializedArrayBuffersKiB.toFixed(1),
		'Removed ArrayBuffers Δ KiB': row.removedArrayBuffersKiB.toFixed(1),
		'Post-dispose ArrayBuffers Δ KiB': row.postDisposeArrayBuffersKiB.toFixed(1),
		'Provider buffers': row.providerArrayBuffers,
		'Provider payload KiB': (row.providerOwnedPayloadBytes / 1_024).toFixed(1),
		'Provider nominal KiB': (row.nominalProviderBytes / 1_024).toFixed(1),
	})),
)
console.log('Structural counts')
console.table(
	rows.map((row) => ({
		'Variants k': row.forks,
		'Prepared definitions': row.preparedDefinitions,
		'Prepared nodes': row.preparedNodes,
		'Prepared graph slots': row.preparedGraphSlots,
		'Prepared graph active': row.preparedGraphActive,
		'Initial generation contexts': row.initialGenerationContexts,
		'Constructed after replace': row.constructedGenerations,
		'Records after remove': row.recordsAfterRemove,
		'Graph tombstones': row.retainedGraphSlots,
		'Identity tombstones': row.retainedIdentityTombstones,
	})),
)
console.log('Fixed-k replacement against unrelated graph size')
console.table(
	fixedFamilyRows.map((row) => ({
		'Variants k': 1,
		'Unrelated nodes': row.background,
		'Replace mean ms': row.meanMs.toFixed(3),
		'Min ms': row.minMs.toFixed(3),
		'Max ms': row.maxMs.toFixed(3),
	})),
)
console.log(
	'Heap deltas are measured aggregate V8 heap changes, not exact object ownership. Prepared includes draft definition/node/graph metadata; commit includes Context/effects, provider JS wrappers, lifecycle state, and measurement noise.',
)
console.log(
	'ArrayBuffers delta is measured independently; provider nominal bytes are the exact configured Uint8Array payload and are not subtracted from heap to fabricate a Context/effects estimate.',
)
console.log(
	'Dependent-closure cost is covered by the lifecycle HMR probe plus PluginService cost-model assertions; this probe isolates definition-family k replacement with cascadeDependents=false.',
)
console.log(
	JSON.stringify(
		{
			providerStateBytes,
			memorySemantics: {
				preparedHeapDelta: 'aggregate baseline-to-prepared V8 heap delta',
				commitHeapDelta: 'aggregate prepared-to-committed V8 heap delta',
				arrayBuffersDelta: 'measured process.memoryUsage().arrayBuffers delta',
				providerOwnedPayloadBytes: 'exact sum of live provider-owned Uint8Array byteLength values',
				nominalProviderBytes: 'fork count multiplied by configured Uint8Array byte length',
			},
			rows,
			fixedFamilyRows,
		},
		null,
		2,
	),
)
