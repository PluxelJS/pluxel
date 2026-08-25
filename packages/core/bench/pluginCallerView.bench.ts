import { BasePlugin, Plugin, pluginNodeAddressOf, type PluginDefinitionAddress } from '@pluxel/core'
import { consumePluginDefinitionCandidate, requirePluginService } from '@pluxel/core/internal'
import { createCoreContext } from '@pluxel/core/test'
import { __definePluginRef, __setPluginDefinition } from '@pluxel/core/toolchain'
import { Bench } from 'tinybench'

const numberFromEnv = (key: string, fallback: number): number => {
	const parsed = Number(process.env[key])
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const timeMs = numberFromEnv('PLUXEL_CALLER_BENCH_TIME_MS', 750)
const warmupTimeMs = numberFromEnv('PLUXEL_CALLER_BENCH_WARMUP_MS', 250)
const syncBatch = Math.floor(numberFromEnv('PLUXEL_CALLER_BENCH_SYNC_BATCH', 1_000))
const asyncBatch = Math.floor(numberFromEnv('PLUXEL_CALLER_BENCH_ASYNC_BATCH', 100))

const providerDefinition = Object.freeze({
	entry: Object.freeze({
		kind: 'source-entry' as const,
		sourceSpace: 'app',
		path: 'core-bench/plugin-caller-view/provider',
	}),
	exportName: 'CallerViewBenchProvider',
}) satisfies PluginDefinitionAddress

const consumerDefinition = Object.freeze({
	entry: Object.freeze({
		kind: 'source-entry' as const,
		sourceSpace: 'app',
		path: 'core-bench/plugin-caller-view/consumer',
	}),
	exportName: 'CallerViewBenchConsumer',
}) satisfies PluginDefinitionAddress

// The benchmark uses the imperative marker because Node's strip-only runner cannot parse decorators.
// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration
class CallerViewBenchProvider extends BasePlugin {
	value = 1

	read(): number {
		return this.value
	}

	async readAsync(): Promise<number> {
		await Promise.resolve()
		return this.value
	}
}

// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration
class CallerViewBenchConsumer extends BasePlugin {
	readonly provider: CallerViewBenchProvider

	constructor(provider: CallerViewBenchProvider) {
		super()
		this.provider = provider
	}
}

Plugin()(CallerViewBenchProvider)
Plugin()(CallerViewBenchConsumer)
__setPluginDefinition(CallerViewBenchProvider, {
	abiVersion: 2,
	kind: 'plugin',
	definition: providerDefinition,
})
__setPluginDefinition(CallerViewBenchConsumer, {
	abiVersion: 2,
	kind: 'plugin',
	definition: consumerDefinition,
	constructorRequires: [providerDefinition],
	optional: [providerDefinition],
})
const providerRef = __definePluginRef<CallerViewBenchProvider>({
	abiVersion: 2,
	definition: providerDefinition,
})

const benchmarkContext = createCoreContext({ name: 'caller-view-benchmark' })
const ctx = benchmarkContext.ctx
const registry = requirePluginService(ctx)
const update = registry.beginUpdate({ reason: 'core-caller-view-benchmark' })
update.materializeNode(
	pluginNodeAddressOf(CallerViewBenchProvider),
	consumePluginDefinitionCandidate(CallerViewBenchProvider),
)
update.materializeNode(
	pluginNodeAddressOf(CallerViewBenchConsumer),
	consumePluginDefinitionCandidate(CallerViewBenchConsumer),
)
const committed = await update.commit()
if (!committed.ok) throw committed.err

const raw = registry.getInstance(
	pluginNodeAddressOf(CallerViewBenchProvider),
) as CallerViewBenchProvider
const consumer = registry.getInstance(
	pluginNodeAddressOf(CallerViewBenchConsumer),
) as CallerViewBenchConsumer
const facade = consumer.provider
const rawBoundRead = raw.read.bind(raw)
const cachedFacadeRead = facade.read
const optionalFacade = registry.resolvePluginRef(providerRef, consumer.ctx)
if (optionalFacade !== facade) {
	throw new Error('Required and optional edges did not reuse the stable caller facade')
}

// This benchmark has one live consumer-generation -> provider-generation edge. Required
// constructor injection and optional lookup are two access paths to that same edge, so identity
// de-duplication gives the number of live facade objects without exposing a production debug API.
const generationEdges = [{ consumer: consumer.ctx, provider: raw }] as const
const uniqueLiveViews = new Set([facade, optionalFacade]).size
const viewsPerEdge = uniqueLiveViews / generationEdges.length
if (uniqueLiveViews !== 1 || viewsPerEdge !== 1) {
	throw new Error('One generation edge must retain exactly one caller facade')
}

let sink = 0
const bench = new Bench({ time: timeMs, warmupTime: warmupTimeMs })
bench.add('raw property read', () => {
	for (let i = 0; i < syncBatch; i++) sink += raw.value
})
bench.add('caller facade property read', () => {
	for (let i = 0; i < syncBatch; i++) sink += facade.value
})
bench.add('raw method call', () => {
	for (let i = 0; i < syncBatch; i++) sink += raw.read()
})
bench.add('caller facade method call', () => {
	for (let i = 0; i < syncBatch; i++) sink += facade.read()
})
bench.add('raw cached method call', () => {
	for (let i = 0; i < syncBatch; i++) sink += rawBoundRead()
})
bench.add('caller facade cached method call', () => {
	for (let i = 0; i < syncBatch; i++) sink += cachedFacadeRead()
})
bench.add('raw async method call', async () => {
	for (let i = 0; i < asyncBatch; i++) sink += await raw.readAsync()
})
bench.add('caller facade async method call', async () => {
	for (let i = 0; i < asyncBatch; i++) sink += await facade.readAsync()
})

try {
	await bench.run()

	const latencyUs = (name: string, batch: number): number => {
		const task = bench.tasks.find((candidate) => candidate.name === name)
		if (!task || task.result.state !== 'completed') {
			throw new Error(`Caller-view benchmark task did not complete: ${name}`)
		}
		return (task.result.latency.mean * 1_000) / batch
	}
	const rows = [
		{
			path: 'property read',
			raw: latencyUs('raw property read', syncBatch),
			facade: latencyUs('caller facade property read', syncBatch),
		},
		{
			path: 'method call',
			raw: latencyUs('raw method call', syncBatch),
			facade: latencyUs('caller facade method call', syncBatch),
		},
		{
			path: 'cached method call',
			raw: latencyUs('raw cached method call', syncBatch),
			facade: latencyUs('caller facade cached method call', syncBatch),
		},
		{
			path: 'async method call',
			raw: latencyUs('raw async method call', asyncBatch),
			facade: latencyUs('caller facade async method call', asyncBatch),
		},
	].map((row) => ({
		Path: row.path,
		'Raw us/op': row.raw.toFixed(3),
		'Facade us/op': row.facade.toFixed(3),
		'Overhead ratio': `${(row.facade / row.raw).toFixed(2)}x`,
		'Overhead us/op': (row.facade - row.raw).toFixed(3),
	}))

	console.table(rows)
	console.table([
		{
			'Generation edges': generationEdges.length,
			'Unique live views': uniqueLiveViews,
			'Views / edge': viewsPerEdge.toFixed(2),
			'Required === optional': optionalFacade === facade,
		},
	])
	console.log(`Caller-view benchmark sink: ${sink}`)
} finally {
	const shutdown = registry.beginUpdate({ reason: 'core-caller-view-benchmark-shutdown' })
	shutdown.dematerializeNode(pluginNodeAddressOf(CallerViewBenchProvider))
	await shutdown.commit()
	await benchmarkContext.dispose()
}
