import type { ExportResult } from '@opentelemetry/core'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'
import {
	AggregationTemporality,
	AggregationType,
	PeriodicExportingMetricReader,
	type AggregationOption,
	type InstrumentType,
	type PushMetricExporter,
} from '@opentelemetry/sdk-metrics'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { OtelSignal } from './config.ts'
import { safeErrorType } from './diagnostics.ts'
import {
	resolveMetricReaderConfig,
	resolveOtlpConfig,
	type OtelEnvironment,
	type ResolvedOtlpConfig,
} from './env.ts'

export type OtlpExportState =
	| Readonly<{ signal: OtelSignal; ok: true }>
	| Readonly<{ signal: OtelSignal; ok: false; errorType: string }>

type MaybePromise<T> = T | Promise<T>

export type OtlpExporterFactories = Readonly<{
	metrics?: (config: ResolvedOtlpConfig) => MaybePromise<PushMetricExporter>
	traces?: (config: ResolvedOtlpConfig) => MaybePromise<SpanExporter>
	logs?: (config: ResolvedOtlpConfig) => MaybePromise<LogRecordExporter>
}>

type ExportStateHook = (state: OtlpExportState) => void

function invokeHook(run: () => void): void {
	try {
		run()
	} catch {
		// Export diagnostics cannot affect SDK collection or application code.
	}
}

function reportResult(signal: OtelSignal, result: ExportResult, hook: ExportStateHook): void {
	const state: OtlpExportState =
		result.code === 0
			? { signal, ok: true }
			: { signal, ok: false, errorType: safeErrorType(result.error) }
	invokeHook(() => hook(state))
}

class DiagnosticMetricExporter implements PushMetricExporter {
	private readonly inner: PushMetricExporter
	private readonly hook: ExportStateHook

	constructor(inner: PushMetricExporter, hook: ExportStateHook) {
		this.inner = inner
		this.hook = hook
	}

	export(
		metrics: Parameters<PushMetricExporter['export']>[0],
		resultCallback: Parameters<PushMetricExporter['export']>[1],
	): void {
		try {
			this.inner.export(metrics, (result) => {
				reportResult('metrics', result, this.hook)
				resultCallback(result)
			})
		} catch (error) {
			invokeHook(() => this.hook({ signal: 'metrics', ok: false, errorType: safeErrorType(error) }))
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
		return (
			this.inner.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.CUMULATIVE
		)
	}

	selectAggregation(instrumentType: InstrumentType): AggregationOption {
		return this.inner.selectAggregation?.(instrumentType) ?? { type: AggregationType.DEFAULT }
	}
}

class DiagnosticSpanExporter implements SpanExporter {
	private readonly inner: SpanExporter
	private readonly hook: ExportStateHook

	constructor(inner: SpanExporter, hook: ExportStateHook) {
		this.inner = inner
		this.hook = hook
	}

	export(
		spans: Parameters<SpanExporter['export']>[0],
		resultCallback: Parameters<SpanExporter['export']>[1],
	): void {
		try {
			this.inner.export(spans, (result) => {
				reportResult('traces', result, this.hook)
				resultCallback(result)
			})
		} catch (error) {
			invokeHook(() => this.hook({ signal: 'traces', ok: false, errorType: safeErrorType(error) }))
			throw error
		}
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}
}

class DiagnosticLogExporter implements LogRecordExporter {
	private readonly inner: LogRecordExporter
	private readonly hook: ExportStateHook

	constructor(inner: LogRecordExporter, hook: ExportStateHook) {
		this.inner = inner
		this.hook = hook
	}

	export(
		logs: Parameters<LogRecordExporter['export']>[0],
		resultCallback: Parameters<LogRecordExporter['export']>[1],
	): void {
		try {
			this.inner.export(logs, (result) => {
				reportResult('logs', result, this.hook)
				resultCallback(result)
			})
		} catch (error) {
			invokeHook(() => this.hook({ signal: 'logs', ok: false, errorType: safeErrorType(error) }))
			throw error
		}
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}
}

function httpOptions(config: ResolvedOtlpConfig) {
	return {
		url: config.endpoint,
		headers: { ...config.headers },
		timeoutMillis: config.timeoutMs,
		compression: config.compression,
		concurrencyLimit: 1,
	}
}

async function grpcOptions(config: ResolvedOtlpConfig) {
	const { Metadata } = await import('@grpc/grpc-js')
	const metadata = new Metadata()
	for (const [key, value] of Object.entries(config.headers)) metadata.set(key, value)
	return {
		url: config.endpoint,
		metadata,
		timeoutMillis: config.timeoutMs,
		compression: config.compression,
		concurrencyLimit: 1,
	}
}

async function createDefaultMetricExporter(
	config: ResolvedOtlpConfig,
): Promise<PushMetricExporter> {
	if (config.protocol === 'grpc') {
		const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-grpc')
		return new OTLPMetricExporter(
			(await grpcOptions(config)) as ConstructorParameters<typeof OTLPMetricExporter>[0],
		)
	}
	if (config.protocol === 'http/json') {
		const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http')
		return new OTLPMetricExporter(
			httpOptions(config) as ConstructorParameters<typeof OTLPMetricExporter>[0],
		)
	}
	const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-proto')
	return new OTLPMetricExporter(
		httpOptions(config) as ConstructorParameters<typeof OTLPMetricExporter>[0],
	)
}

async function createDefaultSpanExporter(config: ResolvedOtlpConfig): Promise<SpanExporter> {
	if (config.protocol === 'grpc') {
		const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc')
		return new OTLPTraceExporter(
			(await grpcOptions(config)) as ConstructorParameters<typeof OTLPTraceExporter>[0],
		)
	}
	if (config.protocol === 'http/json') {
		const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
		return new OTLPTraceExporter(
			httpOptions(config) as ConstructorParameters<typeof OTLPTraceExporter>[0],
		)
	}
	const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto')
	return new OTLPTraceExporter(
		httpOptions(config) as ConstructorParameters<typeof OTLPTraceExporter>[0],
	)
}

async function createDefaultLogExporter(config: ResolvedOtlpConfig): Promise<LogRecordExporter> {
	if (config.protocol === 'grpc') {
		const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-grpc')
		return new OTLPLogExporter(
			(await grpcOptions(config)) as ConstructorParameters<typeof OTLPLogExporter>[0],
		)
	}
	if (config.protocol === 'http/json') {
		const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http')
		return new OTLPLogExporter(
			httpOptions(config) as ConstructorParameters<typeof OTLPLogExporter>[0],
		)
	}
	const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-proto')
	return new OTLPLogExporter(
		httpOptions(config) as ConstructorParameters<typeof OTLPLogExporter>[0],
	)
}

export async function createOtlpMetricReader(options: {
	env: OtelEnvironment
	factory?: OtlpExporterFactories['metrics']
	onExportState: ExportStateHook
}): Promise<{ reader: PeriodicExportingMetricReader; timeoutMs: number }> {
	const exporterConfig = resolveOtlpConfig(options.env, 'metrics')
	const readerConfig = resolveMetricReaderConfig(options.env)
	const inner = await (options.factory ?? createDefaultMetricExporter)(exporterConfig)
	try {
		return {
			reader: new PeriodicExportingMetricReader({
				exporter: new DiagnosticMetricExporter(inner, options.onExportState),
				exportIntervalMillis: readerConfig.intervalMs,
				exportTimeoutMillis: readerConfig.timeoutMs,
			}),
			timeoutMs: readerConfig.timeoutMs,
		}
	} catch (error) {
		try {
			await inner.shutdown()
		} catch {
			// Preserve the reader initialization failure.
		}
		throw error
	}
}

export async function createOtlpSpanExporter(options: {
	env: OtelEnvironment
	factory?: OtlpExporterFactories['traces']
	onExportState: ExportStateHook
}): Promise<SpanExporter> {
	const config = resolveOtlpConfig(options.env, 'traces')
	const exporter = await (options.factory ?? createDefaultSpanExporter)(config)
	return new DiagnosticSpanExporter(exporter, options.onExportState)
}

export async function createOtlpLogExporter(options: {
	env: OtelEnvironment
	factory?: OtlpExporterFactories['logs']
	onExportState: ExportStateHook
}): Promise<LogRecordExporter> {
	const config = resolveOtlpConfig(options.env, 'logs')
	const exporter = await (options.factory ?? createDefaultLogExporter)(config)
	return new DiagnosticLogExporter(exporter, options.onExportState)
}
