import type { Logger, Meter, Tracer } from '@opentelemetry/api'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { MeterProvider, type MetricReader } from '@opentelemetry/sdk-metrics'
import { TracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace'
import type { OtelSignal } from './config.ts'
import { ensureOtelProcessContext } from './context.ts'
import {
	resolveBatchProcessorConfig,
	resolveResourceAttributes,
	resolveTraceSampler,
	type OtelEnvironment,
} from './env.ts'
import type { OtlpExporterFactories, OtlpExportState } from './otlp.ts'
import type { PrometheusPullReader } from './prometheus.ts'

const DEFAULT_PROVIDER_SHUTDOWN_TIMEOUT_MS = 30_000

/** Native SDK providers transferred to one Otel generation. */
export type OtelProviders = Readonly<{
	meterProvider?: MeterProvider
	tracerProvider?: TracerProvider
	loggerProvider?: LoggerProvider
}>

export type ManagedOtelProviders = Readonly<{
	providers: OtelProviders
	otlp: readonly OtelSignal[]
	prometheus?: PrometheusPullReader
	prometheusPath?: string
	metricShutdownTimeoutMs: number
}>

const managedProviderSets = new WeakMap<OtelProviders, ManagedOtelProviders>()

export type OtelRuntime = Readonly<{
	getMeter(scopeName: string): Meter
	getTracer(scopeName: string): Tracer
	getLogger(scopeName: string): Logger
	outputs: Readonly<Record<OtelSignal, 'disabled' | 'managed' | 'external'>>
	prometheus?: PrometheusPullReader
	prometheusPath?: string
	forceFlush(): Promise<void>
	shutdown(): Promise<void>
}>

export type CreateOtelRuntimeInput = Readonly<{
	rootName: string
	otlp: readonly OtelSignal[]
	prometheus: boolean
	prometheusPath?: string
	onOtlpExportState: (state: OtlpExportState) => void
}>

export type CreateOtelRuntimeOptions = Readonly<{
	env?: OtelEnvironment
	exporterFactories?: OtlpExporterFactories
}>

type ShutdownTask = () => Promise<void>

async function shutdownAll(tasks: ShutdownTask[], errorMessage: string): Promise<void> {
	const results = await Promise.allSettled(tasks.map(async (task) => task()))
	const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
	if (errors.length > 0) throw new AggregateError(errors, errorMessage)
}

async function failAfterCleanup(initialFailure: unknown, cleanup: ShutdownTask): Promise<never> {
	const [result] = await Promise.allSettled([cleanup].map(async (task) => task()))
	if (result.status === 'rejected') {
		throw new AggregateError(
			[initialFailure, result.reason],
			'OpenTelemetry initialization and cleanup failed',
			{
				cause: initialFailure,
			},
		)
	}
	throw initialFailure
}

export async function createOtelProviders(
	input: CreateOtelRuntimeInput,
	options: CreateOtelRuntimeOptions = {},
): Promise<ManagedOtelProviders> {
	if (input.otlp.length === 0 && !input.prometheus) {
		throw new Error('at least one OTLP signal or Prometheus output must be enabled')
	}
	const env = options.env ?? process.env
	const resource = defaultResource().merge(
		resourceFromAttributes(resolveResourceAttributes(env, input.rootName)),
	)
	const metricsEnabled = input.prometheus || input.otlp.includes('metrics')
	let metricProvider: MeterProvider | undefined
	let tracerProvider: TracerProvider | undefined
	let loggerProvider: LoggerProvider | undefined
	let metricReaders: MetricReader[] = []
	let traceProcessor: BatchSpanProcessor | undefined
	let logProcessor: BatchLogRecordProcessor | undefined
	let prometheus: PrometheusPullReader | undefined
	let metricShutdownTimeoutMs = DEFAULT_PROVIDER_SHUTDOWN_TIMEOUT_MS

	try {
		if (metricsEnabled) {
			if (input.otlp.includes('metrics')) {
				const { createOtlpMetricReader } = await import('./otlp.ts')
				const otlp = await createOtlpMetricReader({
					env,
					factory: options.exporterFactories?.metrics,
					onExportState: input.onOtlpExportState,
				})
				metricShutdownTimeoutMs = otlp.timeoutMs
				metricReaders.push(otlp.reader)
			}
			if (input.prometheus) {
				const { PrometheusPullReader } = await import('./prometheus.ts')
				prometheus = new PrometheusPullReader()
				metricReaders.push(prometheus)
			}
			metricProvider = new MeterProvider({ resource, readers: metricReaders })
		}

		if (input.otlp.includes('traces')) {
			const { createOtlpSpanExporter } = await import('./otlp.ts')
			const processorConfig = resolveBatchProcessorConfig(env, 'traces')
			const sampler = resolveTraceSampler(env)
			const exporter = await createOtlpSpanExporter({
				env,
				factory: options.exporterFactories?.traces,
				onExportState: input.onOtlpExportState,
			})
			try {
				traceProcessor = new BatchSpanProcessor({ exporter, ...processorConfig })
			} catch (error) {
				return await failAfterCleanup(error, () => exporter.shutdown())
			}
			tracerProvider = new TracerProvider({ resource, sampler, spanProcessors: [traceProcessor] })
		}

		if (input.otlp.includes('logs')) {
			const { createOtlpLogExporter } = await import('./otlp.ts')
			const processorConfig = resolveBatchProcessorConfig(env, 'logs')
			const exporter = await createOtlpLogExporter({
				env,
				factory: options.exporterFactories?.logs,
				onExportState: input.onOtlpExportState,
			})
			try {
				logProcessor = new BatchLogRecordProcessor({ exporter, ...processorConfig })
			} catch (error) {
				return await failAfterCleanup(error, () => exporter.shutdown())
			}
			loggerProvider = new LoggerProvider({ resource, processors: [logProcessor] })
		}

		const managed: ManagedOtelProviders = {
			providers: {
				meterProvider: metricProvider,
				tracerProvider,
				loggerProvider,
			},
			otlp: [...input.otlp],
			prometheus,
			prometheusPath: input.prometheusPath,
			metricShutdownTimeoutMs,
		}
		managedProviderSets.set(managed.providers, managed)
		return managed
	} catch (error) {
		const shutdowns: ShutdownTask[] = []
		if (metricProvider) {
			shutdowns.push(() => metricProvider.shutdown({ timeoutMillis: metricShutdownTimeoutMs }))
		} else {
			shutdowns.push(...metricReaders.map((reader) => () => reader.shutdown()))
		}
		if (tracerProvider) shutdowns.push(() => tracerProvider.shutdown())
		else if (traceProcessor) shutdowns.push(() => traceProcessor.shutdown())
		if (loggerProvider) shutdowns.push(() => loggerProvider.shutdown())
		else if (logProcessor) shutdowns.push(() => logProcessor.shutdown())
		return failAfterCleanup(error, () =>
			shutdownAll(shutdowns, 'OpenTelemetry initialization cleanup failed'),
		)
	}
}

export async function createRuntimeFromProviders(
	providers: OtelProviders,
	managed = managedProviderSets.get(providers),
): Promise<OtelRuntime> {
	const { meterProvider, tracerProvider, loggerProvider } = providers
	if (!meterProvider && !tracerProvider && !loggerProvider) {
		throw new Error('Otel.createProviders() must return at least one native provider')
	}
	const isManaged = {
		metrics: meterProvider !== undefined && managed?.providers.meterProvider === meterProvider,
		traces: tracerProvider !== undefined && managed?.providers.tracerProvider === tracerProvider,
		logs: loggerProvider !== undefined && managed?.providers.loggerProvider === loggerProvider,
	}
	const output = (signal: OtelSignal, present: boolean): 'disabled' | 'managed' | 'external' => {
		if (!present) return 'disabled'
		if (!isManaged[signal]) return 'external'
		return managed?.otlp.includes(signal) ? 'managed' : 'disabled'
	}
	let shutdownPromise: Promise<void> | undefined
	const runtime: OtelRuntime = {
		getMeter(scopeName): Meter {
			if (!meterProvider) throw new Error('OpenTelemetry metrics signal is disabled')
			return meterProvider.getMeter(scopeName)
		},
		getTracer(scopeName): Tracer {
			if (!tracerProvider) throw new Error('OpenTelemetry traces signal is disabled')
			return tracerProvider.getTracer(scopeName)
		},
		getLogger(scopeName): Logger {
			if (!loggerProvider) throw new Error('OpenTelemetry logs signal is disabled')
			return loggerProvider.getLogger(scopeName)
		},
		outputs: {
			metrics: output('metrics', meterProvider !== undefined),
			traces: output('traces', tracerProvider !== undefined),
			logs: output('logs', loggerProvider !== undefined),
		},
		prometheus: isManaged.metrics ? managed?.prometheus : undefined,
		prometheusPath: isManaged.metrics ? managed?.prometheusPath : undefined,
		forceFlush(): Promise<void> {
			return shutdownAll(
				[
					...(meterProvider ? [() => meterProvider.forceFlush()] : []),
					...(tracerProvider ? [() => tracerProvider.forceFlush()] : []),
					...(loggerProvider ? [() => loggerProvider.forceFlush()] : []),
				],
				'OpenTelemetry provider flush failed',
			)
		},
		shutdown(): Promise<void> {
			shutdownPromise ??= shutdownAll(
				[
					...(meterProvider
						? [
								() =>
									isManaged.metrics && managed
										? meterProvider.shutdown({ timeoutMillis: managed.metricShutdownTimeoutMs })
										: meterProvider.shutdown(),
							]
						: []),
					...(tracerProvider ? [() => tracerProvider.shutdown()] : []),
					...(loggerProvider ? [() => loggerProvider.shutdown()] : []),
				],
				'OpenTelemetry provider shutdown failed',
			)
			return shutdownPromise
		},
	}
	try {
		if (tracerProvider || loggerProvider) ensureOtelProcessContext()
		return runtime
	} catch (error) {
		return failAfterCleanup(error, () => runtime.shutdown())
	}
}

export async function createOtelRuntime(
	input: CreateOtelRuntimeInput,
	options: CreateOtelRuntimeOptions = {},
): Promise<OtelRuntime> {
	const managed = await createOtelProviders(input, options)
	return createRuntimeFromProviders(managed.providers, managed)
}
