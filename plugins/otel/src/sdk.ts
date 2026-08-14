import type { Meter, Tracer } from '@opentelemetry/api'
import type { Logger } from '@opentelemetry/api-logs'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { MeterProvider, type MetricReader } from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { OtelSignal } from './config.ts'
import { ensureOtelProcessContext } from './context.ts'
import {
	resolveBatchProcessorConfig,
	resolveResourceAttributes,
	type OtelEnvironment,
} from './env.ts'
import type { OtlpExporterFactories, OtlpExportState } from './otlp.ts'
import type { PrometheusPullReader } from './prometheus.ts'

const DEFAULT_PROVIDER_SHUTDOWN_TIMEOUT_MS = 30_000

export type OtelRuntime = Readonly<{
	getMeter(scopeName: string): Meter
	getTracer(scopeName: string): Tracer
	getLogger(scopeName: string): Logger
	prometheus?: PrometheusPullReader
	shutdown(): Promise<void>
}>

export type CreateOtelRuntimeInput = Readonly<{
	rootName: string
	otlp: readonly OtelSignal[]
	prometheus: boolean
	onOtlpExportState: (state: OtlpExportState) => void
}>

export type CreateOtelRuntimeOptions = Readonly<{
	env?: OtelEnvironment
	exporterFactories?: OtlpExporterFactories
}>

type ShutdownTask = () => Promise<void>

async function shutdownAll(tasks: ShutdownTask[], errorMessage?: string): Promise<void> {
	const results = await Promise.allSettled(tasks.map(async (task) => task()))
	const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
	if (errors.length > 0 && errorMessage) throw new AggregateError(errors, errorMessage)
}

export async function createOtelRuntime(
	input: CreateOtelRuntimeInput,
	options: CreateOtelRuntimeOptions = {},
): Promise<OtelRuntime> {
	const env = options.env ?? process.env
	const resource = defaultResource().merge(
		resourceFromAttributes(resolveResourceAttributes(env, input.rootName)),
	)
	const metricsEnabled = input.prometheus || input.otlp.includes('metrics')
	let metricProvider: MeterProvider | undefined
	let tracerProvider: BasicTracerProvider | undefined
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
			const exporter = await createOtlpSpanExporter({
				env,
				factory: options.exporterFactories?.traces,
				onExportState: input.onOtlpExportState,
			})
			try {
				traceProcessor = new BatchSpanProcessor(exporter, processorConfig)
			} catch (error) {
				try {
					await exporter.shutdown()
				} catch {
					// Preserve the processor initialization failure.
				}
				throw error
			}
			tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [traceProcessor] })
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
				try {
					await exporter.shutdown()
				} catch {
					// Preserve the processor initialization failure.
				}
				throw error
			}
			loggerProvider = new LoggerProvider({ resource, processors: [logProcessor] })
		}

		if (input.otlp.includes('traces') || input.otlp.includes('logs')) {
			ensureOtelProcessContext()
		}

		const activeMetricProvider = metricProvider
		const activeTracerProvider = tracerProvider
		const activeLoggerProvider = loggerProvider
		let shutdownPromise: Promise<void> | undefined
		return {
			getMeter(scopeName): Meter {
				if (!activeMetricProvider) throw new Error('OpenTelemetry metrics signal is disabled')
				return activeMetricProvider.getMeter(scopeName)
			},
			getTracer(scopeName): Tracer {
				if (!activeTracerProvider) throw new Error('OpenTelemetry traces signal is disabled')
				return activeTracerProvider.getTracer(scopeName)
			},
			getLogger(scopeName): Logger {
				if (!activeLoggerProvider) throw new Error('OpenTelemetry logs signal is disabled')
				return activeLoggerProvider.getLogger(scopeName)
			},
			prometheus,
			shutdown(): Promise<void> {
				shutdownPromise ??= shutdownAll(
					[
						...(activeMetricProvider
							? [() => activeMetricProvider.shutdown({ timeoutMillis: metricShutdownTimeoutMs })]
							: []),
						...(activeTracerProvider ? [() => activeTracerProvider.shutdown()] : []),
						...(activeLoggerProvider ? [() => activeLoggerProvider.shutdown()] : []),
					],
					'OpenTelemetry provider shutdown failed',
				)
				return shutdownPromise
			},
		}
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
		await shutdownAll(shutdowns)
		throw error
	}
}
