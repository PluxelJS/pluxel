import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import {
	AggregationTemporality,
	AggregationType,
	MeterProvider,
	PeriodicExportingMetricReader,
	type AggregationOption,
	type InstrumentType,
	type PushMetricExporter,
} from '@opentelemetry/sdk-metrics'
import {
	ATTR_CAPACITY_LIMIT,
	DURATION_BUCKETS_SECONDS,
	MAX_OPERATIONS,
	METRIC_CALLS,
	METRIC_CAPACITY_DROPS,
	METRIC_DURATION,
} from './constants.ts'
import { resolveOtlpConfig, type ResolvedOtlpConfig } from './env.ts'
import type {
	ExportState,
	MetricsRecorder,
	OperationMetric,
	OperationResult,
	RecorderHooks,
} from './recorder.ts'

type Environment = Readonly<Record<string, string | undefined>>

export type MetricsExporterFactory = (config: ResolvedOtlpConfig) => PushMetricExporter

export type CreateOtlpRecorderInput = Readonly<{
	rootName: string
	hooks: RecorderHooks
}>

export type CreateOtlpRecorderOptions = Readonly<{
	env?: Environment
	exporterFactory?: MetricsExporterFactory
}>

function safeErrorType(error: unknown): string {
	try {
		if (error && typeof error === 'object') {
			const name = (error as { name?: unknown }).name
			if (typeof name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(name)) return name
		}
	} catch {
		return 'unknown'
	}
	return error === null ? 'null' : typeof error
}

function invokeHook(run: () => void): void {
	try {
		run()
	} catch {
		// Telemetry hooks cannot affect SDK collection/export.
	}
}

class HookedExporter implements PushMetricExporter {
	private readonly inner: PushMetricExporter
	private readonly hooks: RecorderHooks

	constructor(inner: PushMetricExporter, hooks: RecorderHooks) {
		this.inner = inner
		this.hooks = hooks
	}

	export(
		metrics: Parameters<PushMetricExporter['export']>[0],
		resultCallback: Parameters<PushMetricExporter['export']>[1],
	): void {
		try {
			this.inner.export(metrics, (result) => {
				const state: ExportState =
					result.code === 0 ? { ok: true } : { ok: false, errorType: safeErrorType(result.error) }
				invokeHook(() => this.hooks.onExportState(state))
				resultCallback(result)
			})
		} catch (error) {
			invokeHook(() => this.hooks.onExportState({ ok: false, errorType: safeErrorType(error) }))
			throw error
		}
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}

	selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
		return this.inner.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.DELTA
	}

	selectAggregation(instrumentType: InstrumentType): AggregationOption {
		return (
			this.inner.selectAggregation?.(instrumentType) ?? {
				type: AggregationType.DEFAULT,
			}
		)
	}
}

class HookedMetricReader extends PeriodicExportingMetricReader {
	private readonly hooks: RecorderHooks

	constructor(
		options: ConstructorParameters<typeof PeriodicExportingMetricReader>[0],
		hooks: RecorderHooks,
	) {
		super(options)
		this.hooks = hooks
	}

	override async collect(options?: Parameters<PeriodicExportingMetricReader['collect']>[0]) {
		const result = await super.collect(options)
		invokeHook(this.hooks.onCollection)
		return result
	}
}

export function createDefaultExporter(config: ResolvedOtlpConfig): PushMetricExporter {
	return new OTLPMetricExporter({
		url: config.endpoint,
		headers: { ...config.headers },
		timeoutMillis: config.timeoutMs,
		concurrencyLimit: 1,
		temporalityPreference: AggregationTemporality.DELTA,
	})
}

export async function createOtlpRecorder(
	input: CreateOtlpRecorderInput,
	options: CreateOtlpRecorderOptions = {},
): Promise<MetricsRecorder> {
	const config = resolveOtlpConfig(options.env ?? process.env, input.rootName)
	const innerExporter = (options.exporterFactory ?? createDefaultExporter)(config)
	let provider: MeterProvider | undefined
	try {
		const exporter = new HookedExporter(innerExporter, input.hooks)
		const reader = new HookedMetricReader(
			{
				exporter,
				exportIntervalMillis: config.intervalMs,
				exportTimeoutMillis: config.timeoutMs,
				cardinalityLimits: {
					counter: MAX_OPERATIONS * 2 + 1,
					histogram: MAX_OPERATIONS + 1,
					default: MAX_OPERATIONS + 1,
				},
			},
			input.hooks,
		)
		const resource = defaultResource().merge(resourceFromAttributes(config.resourceAttributes))
		const activeProvider = new MeterProvider({
			resource,
			readers: [reader],
			views: [
				{
					instrumentName: METRIC_CALLS,
					aggregationCardinalityLimit: MAX_OPERATIONS * 2 + 1,
				},
				{
					instrumentName: METRIC_DURATION,
					aggregation: {
						type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
						options: {
							boundaries: [...DURATION_BUCKETS_SECONDS],
							recordMinMax: true,
						},
					},
					aggregationCardinalityLimit: MAX_OPERATIONS + 1,
				},
				{
					instrumentName: METRIC_CAPACITY_DROPS,
					aggregationCardinalityLimit: 3,
				},
			],
		})
		provider = activeProvider
		const meter = activeProvider.getMeter('@pluxel/metrics')
		const calls = meter.createCounter(METRIC_CALLS, {
			description: 'Completed Pluxel plugin operations',
			unit: '{call}',
		})
		const duration = meter.createHistogram(METRIC_DURATION, {
			description: 'Completed Pluxel plugin operation duration',
			unit: 's',
		})
		const capacityDrops = meter.createCounter(METRIC_CAPACITY_DROPS, {
			description: 'Pluxel operation measurements dropped at a cardinality limit',
			unit: '{drop}',
		})

		let shutdownPromise: Promise<void> | undefined
		return {
			record(operation: OperationMetric, result: OperationResult, durationSeconds: number): void {
				calls.add(1, result === 'ok' ? operation.okAttributes : operation.errorAttributes)
				duration.record(durationSeconds, operation.durationAttributes)
			},
			recordCapacityDrop(limit): void {
				capacityDrops.add(1, { [ATTR_CAPACITY_LIMIT]: limit })
			},
			shutdown(): Promise<void> {
				shutdownPromise ??= activeProvider.shutdown({ timeoutMillis: config.timeoutMs })
				return shutdownPromise
			},
		}
	} catch (error) {
		try {
			if (provider) await provider.shutdown({ timeoutMillis: config.timeoutMs })
			else await innerExporter.shutdown()
		} catch {
			// Preserve the initialization error after best-effort cleanup.
		}
		throw error
	}
}
