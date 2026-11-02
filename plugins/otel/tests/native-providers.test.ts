import { BasePlugin, formatPluginNodeReference, Plugin } from '@pluxel/core'
import { standardServices } from '@pluxel/services'
import { createTestHost } from '@pluxel/test'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
	BatchLogRecordProcessor,
	InMemoryLogRecordExporter,
	LoggerProvider,
} from '@opentelemetry/sdk-logs'
import {
	AggregationTemporality,
	AggregationType,
	createAllowListAttributesProcessor,
	DataPointType,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	InMemorySpanExporter,
	SamplingDecision,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { describe, expect, it, vi } from 'vitest'
import { Otel, OtelPlugin, OtelWorkbench, type OtelProviders } from '../src/index.ts'

@Plugin(Otel)
class NativeOtel extends Otel {
	readonly metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
	readonly spans = new InMemorySpanExporter()
	readonly extraSpans = new InMemorySpanExporter()
	readonly logs = new InMemoryLogRecordExporter()
	providers!: OtelProviders
	hookCalls = 0

	protected override async init(): Promise<void> {
		await super.init()
		this.ctx.workbench?.publish(OtelWorkbench, {
			operations: () => this.workbenchOperations(),
		})
	}

	protected override async createProviders(): Promise<OtelProviders> {
		this.hookCalls += 1
		const resource = resourceFromAttributes({ 'service.name': 'native-application' })
		this.providers = {
			meterProvider: new MeterProvider({
				resource,
				readers: [
					new PeriodicExportingMetricReader({
						exporter: this.metrics,
						exportIntervalMillis: 300_000,
					}),
				],
				views: [
					{
						instrumentName: 'native.latency',
						name: 'native.request.duration',
						attributesProcessors: [createAllowListAttributesProcessor(['region'])],
						aggregation: {
							type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
							options: { boundaries: [1, 5, 10] },
						},
					},
				],
			}),
			tracerProvider: new BasicTracerProvider({
				resource,
				sampler: {
					shouldSample: (_context, _traceId, name) => ({
						decision:
							name === 'native.keep'
								? SamplingDecision.RECORD_AND_SAMPLED
								: SamplingDecision.NOT_RECORD,
					}),
					toString: () => 'ApplicationSampler',
				},
				spanLimits: { attributeCountLimit: 1 },
				spanProcessors: [
					new BatchSpanProcessor(this.spans, { scheduledDelayMillis: 300_000 }),
					new SimpleSpanProcessor(this.extraSpans),
				],
			}),
			loggerProvider: new LoggerProvider({
				resource,
				loggerConfigurator: () => ({
					disabled: false,
					minimumSeverity: SeverityNumber.WARN,
					traceBased: false,
				}),
				processors: [
					new BatchLogRecordProcessor({ exporter: this.logs, scheduledDelayMillis: 300_000 }),
				],
			}),
		}
		return this.providers
	}
}

@Plugin(Otel)
class TracesOnly extends Otel {
	protected override async init(): Promise<void> {
		await super.init()
		this.ctx.workbench?.publish(OtelWorkbench, {
			operations: () => this.workbenchOperations(),
		})
	}

	protected override async createProviders(): Promise<OtelProviders> {
		return { tracerProvider: new BasicTracerProvider() }
	}
}

@Plugin(Otel)
class EmptyOtel extends Otel {
	protected override async createProviders(): Promise<OtelProviders> {
		return {}
	}
}

const failedInitClosed: string[] = []

@Plugin(Otel)
class InitFailureOtel extends NativeOtel {
	protected override async createProviders(): Promise<OtelProviders> {
		const providers = await super.createProviders()
		for (const [name, exporter] of [
			['metrics', this.metrics],
			['traces', this.spans],
			['extra traces', this.extraSpans],
			['logs', this.logs],
		] as const) {
			const shutdown = exporter.shutdown.bind(exporter)
			vi.spyOn(exporter, 'shutdown').mockImplementation(async () => {
				failedInitClosed.push(name)
				await shutdown()
			})
		}
		return providers
	}

	protected override async init(): Promise<void> {
		await super.init()
		throw new Error('application init failed after provider handoff')
	}
}

@Plugin()
class NativeConsumer extends BasePlugin {
	constructor(readonly otel: Otel) {
		super()
	}

	async record(): Promise<void> {
		this.otel.meter
			.createHistogram('native.latency')
			.record(3, { region: 'hk', unselected: 'drop' })
		this.otel.tracer.startSpan('native.drop').end()
		await this.otel.tracer.startActiveSpan('native.keep', async (span) => {
			try {
				await Promise.resolve()
				span.setAttribute('kept', 'first').setAttribute('dropped', 'second')
				this.otel.logger.emit({ severityNumber: SeverityNumber.INFO, body: 'filtered' })
				this.otel.logger.emit({ severityNumber: SeverityNumber.WARN, body: 'native warning' })
			} finally {
				span.end()
			}
		})
	}
}

describe('native OpenTelemetry providers', () => {
	it('uses the same abstract dependency for the native provider and default preset', async () => {
		await using host = await createTestHost({ services: standardServices(), workbench: true })
		await host.start(NativeOtel, { catalog: [NativeConsumer] })
		await host.start(NativeConsumer)
		const otel = host.require(NativeOtel)
		const consumer = host.require(NativeConsumer)
		const scope = formatPluginNodeReference(consumer.ctx.pluginInfo.nodeAddress)
		expect(consumer.otel instanceof NativeOtel).toBe(true)
		expect(consumer.otel.meter).toBe(consumer.otel.meter)
		expect(otel.hookCalls).toBe(1)
		await consumer.record()

		using opened = await host.workbench.open({
			target: NativeOtel,
			entry: OtelWorkbench.operations,
			principal: { provider: 'local', subject: 'local' },
		})
		await expect(opened.root.subscribeDto(() => undefined)).resolves.toMatchObject({
			ok: true,
			data: {
				status: {
					metrics: { state: 'external', errorType: null },
					traces: { state: 'external', errorType: null },
					logs: { state: 'external', errorType: null },
					prometheus: { state: 'disabled', path: null },
				},
			},
		})
		await expect(opened.root.runDto('flush')).resolves.toMatchObject({ action: { ok: true } })
		const resourceMetrics = otel.metrics.getMetrics().find((value) => value.scopeMetrics.length)
		expect(resourceMetrics?.resource.attributes['service.name']).toBe('native-application')
		const scopeMetrics = resourceMetrics?.scopeMetrics.find((value) => value.scope.name === scope)
		const histogram = scopeMetrics?.metrics.find(
			(value) => value.descriptor.name === 'native.request.duration',
		)
		expect(histogram?.dataPointType).toBe(DataPointType.HISTOGRAM)
		if (histogram?.dataPointType !== DataPointType.HISTOGRAM) throw new Error('Missing histogram')
		expect(histogram.dataPoints[0]).toMatchObject({
			attributes: { region: 'hk' },
			value: { count: 1, sum: 3, buckets: { boundaries: [1, 5, 10], counts: [0, 1, 0, 0] } },
		})
		expect(histogram.dataPoints[0]!.attributes).not.toHaveProperty('unselected')
		for (const exporter of [otel.spans, otel.extraSpans]) {
			expect(exporter.getFinishedSpans()).toHaveLength(1)
			expect(exporter.getFinishedSpans()[0]).toMatchObject({
				name: 'native.keep',
				attributes: { kept: 'first' },
				instrumentationScope: { name: scope },
			})
		}
		const span = otel.spans.getFinishedSpans()[0]!
		expect(span.attributes).not.toHaveProperty('dropped')
		expect(otel.logs.getFinishedLogRecords()).toHaveLength(1)
		expect(otel.logs.getFinishedLogRecords()[0]).toMatchObject({
			body: 'native warning',
			instrumentationScope: { name: scope },
			spanContext: { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId },
		})

		const shutdowns = [otel.metrics, otel.spans, otel.extraSpans, otel.logs].map((exporter) =>
			vi.spyOn(exporter, 'shutdown'),
		)
		opened[Symbol.dispose]()
		await host.stop(NativeOtel)
		for (const shutdown of shutdowns) expect(shutdown).toHaveBeenCalledTimes(1)
		expect(() => consumer.otel.meter).toThrow('stopped')

		await using defaultHost = await createTestHost({ services: standardServices() })
		await defaultHost.start(OtelPlugin, {
			catalog: [NativeConsumer],
			initialConfig: { otlp: [], prometheus: {} },
		})
		await defaultHost.start(NativeConsumer)
		expect(defaultHost.require(NativeConsumer).otel instanceof OtelPlugin).toBe(true)
	})

	it('reports actual provider presence without inferring outputs from a saved preset', async () => {
		await using host = await createTestHost({ services: standardServices(), workbench: true })
		await host.start(TracesOnly)
		expect(() => host.require(TracesOnly).meter).toThrow('metrics signal is disabled')
		expect(() => host.require(TracesOnly).logger).toThrow('logs signal is disabled')
		using opened = await host.workbench.open({
			target: TracesOnly,
			entry: OtelWorkbench.operations,
			principal: { provider: 'local', subject: 'local' },
		})
		await expect(opened.root.subscribeDto(() => undefined)).resolves.toMatchObject({
			ok: true,
			data: {
				status: {
					metrics: { state: 'disabled' },
					traces: { state: 'external' },
					logs: { state: 'disabled' },
					prometheus: { state: 'disabled', path: null },
				},
			},
		})
	})

	it('reports native flush and shutdown failures while attempting the other providers', async () => {
		await using host = await createTestHost({ services: standardServices(), workbench: true })
		await host.start(NativeOtel)
		const providers = host.require(NativeOtel).providers
		const flushFailure = new Error('native trace flush failed')
		vi.spyOn(providers.tracerProvider!, 'forceFlush').mockRejectedValueOnce(flushFailure)
		const metricFlush = vi.spyOn(providers.meterProvider!, 'forceFlush')
		const logFlush = vi.spyOn(providers.loggerProvider!, 'forceFlush')
		using opened = await host.workbench.open({
			target: NativeOtel,
			entry: OtelWorkbench.operations,
			principal: { provider: 'local', subject: 'local' },
		})
		await opened.root.subscribeDto(() => undefined)
		await expect(opened.root.runDto('flush')).resolves.toMatchObject({ action: { ok: false } })
		expect(metricFlush).toHaveBeenCalledTimes(1)
		expect(logFlush).toHaveBeenCalledTimes(1)
		const shutdown = providers.tracerProvider!.shutdown.bind(providers.tracerProvider)
		vi.spyOn(providers.tracerProvider!, 'shutdown').mockImplementationOnce(async () => {
			await shutdown()
			throw new Error('native trace shutdown failed')
		})
		const metricShutdown = vi.spyOn(providers.meterProvider!, 'shutdown')
		const logShutdown = vi.spyOn(providers.loggerProvider!, 'shutdown')
		const failed = await host.commitExpectFail((change) => change.stop(NativeOtel))
		expect(failed.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({
				phase: 'drain',
				kind: 'drain-failed',
				message: expect.stringContaining('OpenTelemetry provider shutdown failed'),
			}),
		)
		expect(metricShutdown).toHaveBeenCalledTimes(1)
		expect(logShutdown).toHaveBeenCalledTimes(1)
	})

	it('rejects an empty native provider result', async () => {
		await using host = await createTestHost()
		const failure = await host.commitExpectFail((change) => change.start(EmptyOtel))
		expect(failure.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining('at least one native provider') }),
		)
	})

	it('closes handed-off native providers when later generation initialization fails', async () => {
		await using host = await createTestHost()
		const failure = await host.commitExpectFail((change) => change.start(InitFailureOtel))
		expect(failure.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({
				message: 'application init failed after provider handoff',
			}),
		)
		expect(failedInitClosed.toSorted()).toEqual(['extra traces', 'logs', 'metrics', 'traces'])
	})

	it('preserves route registration and native shutdown failures together', async () => {
		const shutdown = MeterProvider.prototype.shutdown
		const closing = vi
			.spyOn(MeterProvider.prototype, 'shutdown')
			.mockImplementation(async function (this: MeterProvider, options) {
				await shutdown.call(this, options)
				throw new Error('native cleanup failed after route registration')
			})
		try {
			await using host = await createTestHost()
			const failure = await host.commitExpectFail((change) => {
				change.config.seed(OtelPlugin, { otlp: [], prometheus: {} })
				change.start(OtelPlugin)
			})
			const start = failure.lifecycleReport.issues.find((issue) => issue.phase === 'start')
			expect(start?.error?.name).toBe('AggregateError')
			expect(start?.message).toContain('OpenTelemetry initialization and cleanup failed')
			expect(start?.message).toContain('does not install services.elysia')
			expect(start?.message).toContain('native cleanup failed after route registration')
			expect(closing).toHaveBeenCalledTimes(1)
		} finally {
			closing.mockRestore()
		}
	})
})
