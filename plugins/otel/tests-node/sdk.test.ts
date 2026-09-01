import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import * as grpc from '@grpc/grpc-js'
import {
	context,
	propagation,
	ROOT_CONTEXT,
	trace,
	type ObservableCallback,
} from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import type { ExportResult } from '@opentelemetry/core'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import {
	AggregationTemporality,
	type PushMetricExporter,
	type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { test } from 'vitest'
import { createOtlpMetricReader, type OtlpExportState } from '../src/otlp.ts'
import { createOtelRuntime } from '../src/sdk.ts'

class CapturingMetricExporter implements PushMetricExporter {
	readonly exports: ResourceMetrics[] = []
	fail = false
	shutdownError: Error | undefined
	shutdownCalls = 0

	export(metrics: ResourceMetrics, callback: (result: ExportResult) => void): void {
		this.exports.push(metrics)
		callback(
			this.fail
				? { code: 1, error: Object.assign(new Error('not exported'), { name: 'NetworkError' }) }
				: { code: 0 },
		)
	}

	async forceFlush(): Promise<void> {}
	shutdown(): Promise<void> {
		this.shutdownCalls += 1
		if (this.shutdownError) throw this.shutdownError
		return Promise.resolve()
	}

	selectAggregationTemporality(): AggregationTemporality {
		return AggregationTemporality.CUMULATIVE
	}
}

class CapturingSpanExporter implements SpanExporter {
	readonly exports: ReadableSpan[][] = []
	shutdownError: Error | undefined
	shutdownCalls = 0

	export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
		this.exports.push(spans)
		callback({ code: 0 })
	}

	async forceFlush(): Promise<void> {}
	shutdown(): Promise<void> {
		this.shutdownCalls += 1
		if (this.shutdownError) throw this.shutdownError
		return Promise.resolve()
	}
}

class CapturingLogExporter implements LogRecordExporter {
	readonly exports: ReadableLogRecord[][] = []
	shutdownError: Error | undefined
	shutdownCalls = 0

	export(logs: ReadableLogRecord[], callback: (result: ExportResult) => void): void {
		this.exports.push(logs)
		callback({ code: 0 })
	}

	async forceFlush(): Promise<void> {}
	shutdown(): Promise<void> {
		this.shutdownCalls += 1
		if (this.shutdownError) throw this.shutdownError
		return Promise.resolve()
	}
}

function metricsByName(resourceMetrics: ResourceMetrics) {
	return new Map(
		resourceMetrics.scopeMetrics.flatMap(({ metrics }) =>
			metrics.map((metric) => [metric.descriptor.name, metric] as const),
		),
	)
}

const testEnv = {
	OTEL_METRIC_EXPORT_INTERVAL: '300000',
	OTEL_METRIC_EXPORT_TIMEOUT: '5000',
	OTEL_BSP_SCHEDULE_DELAY: '300000',
	OTEL_BLRP_SCHEDULE_DELAY: '300000',
} as const

test('exports native metrics, traces, and logs with caller scopes and trace correlation', async () => {
	const metrics = new CapturingMetricExporter()
	const spans = new CapturingSpanExporter()
	const logs = new CapturingLogExporter()
	const states: OtlpExportState[] = []
	const runtime = await createOtelRuntime(
		{
			rootName: 'root',
			otlp: ['metrics', 'traces', 'logs'],
			prometheus: false,
			onOtlpExportState: (state) => states.push(state),
		},
		{
			env: {
				...testEnv,
				OTEL_SERVICE_NAME: 'catalog-service',
				OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=test',
			},
			exporterFactories: {
				metrics: () => metrics,
				traces: () => spans,
				logs: () => logs,
			},
		},
	)

	const meter = runtime.getMeter('CatalogPlugin')
	meter.createCounter('catalog.items', { unit: '{item}' }).add(3, {
		region: 'hk',
		result: 'fresh',
	})
	const active = meter.createObservableGauge('catalog.workers.active')
	const observe: ObservableCallback = (result) => result.observe(4, { region: 'hk' })
	active.addCallback(observe)

	const tracer = runtime.getTracer('CatalogPlugin')
	const logger = runtime.getLogger('CatalogPlugin')
	await tracer.startActiveSpan('catalog.refresh', async (span) => {
		await Promise.resolve()
		assert.equal(trace.getSpan(context.active()), span)
		const carrier: Record<string, string> = {}
		propagation.inject(context.active(), carrier)
		assert.match(carrier.traceparent!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
		assert.equal(
			trace.getSpanContext(propagation.extract(ROOT_CONTEXT, carrier))?.traceId,
			span.spanContext().traceId,
		)
		logger.emit({
			severityNumber: SeverityNumber.INFO,
			severityText: 'INFO',
			body: 'catalog refreshed',
			attributes: { region: 'hk' },
		})
		span.setAttribute('catalog.result', 'fresh')
		span.end()
	})

	await runtime.forceFlush()
	assert.ok(metrics.exports.some(({ scopeMetrics }) => scopeMetrics.length > 0))
	assert.ok(spans.exports.flat().some(({ name }) => name === 'catalog.refresh'))
	assert.ok(logs.exports.flat().some(({ body }) => body === 'catalog refreshed'))

	await runtime.shutdown()
	active.removeCallback(observe)
	await runtime.shutdown()

	assert.equal(metrics.shutdownCalls, 1)
	assert.equal(spans.shutdownCalls, 1)
	assert.equal(logs.shutdownCalls, 1)
	assert.deepEqual(
		new Set(states.filter(({ ok }) => ok).map(({ signal }) => signal)),
		new Set(['metrics', 'traces', 'logs']),
	)

	const metricExport = metrics.exports.find(({ scopeMetrics }) => scopeMetrics.length > 0)
	assert.ok(metricExport)
	assert.equal(metricExport.resource.attributes['service.name'], 'catalog-service')
	assert.equal(metricExport.resource.attributes['deployment.environment.name'], 'test')
	assert.equal(metricExport.scopeMetrics[0]?.scope.name, 'CatalogPlugin')
	const exportedMetrics = metricsByName(metricExport)
	assert.equal(exportedMetrics.get('catalog.items')?.descriptor.unit, '{item}')
	assert.ok(exportedMetrics.has('catalog.workers.active'))

	const span = spans.exports.flat().find(({ name }) => name === 'catalog.refresh')
	const log = logs.exports.flat().find(({ body }) => body === 'catalog refreshed')
	assert.ok(span)
	assert.ok(log)
	assert.equal(span.instrumentationScope.name, 'CatalogPlugin')
	assert.equal(log.instrumentationScope.name, 'CatalogPlugin')
	assert.equal(log.spanContext?.traceId, span.spanContext().traceId)
	assert.equal(log.spanContext?.spanId, span.spanContext().spanId)
	assert.equal(log.resource.attributes['service.name'], 'catalog-service')
})

test('serves Prometheus pull independently and ignores disabled OTLP inputs', async () => {
	let factoryCalled = false
	const runtime = await createOtelRuntime(
		{
			rootName: 'root',
			otlp: [],
			prometheus: true,
			onOtlpExportState() {},
		},
		{
			env: {
				OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'invalid',
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'file:///not-used',
				OTEL_METRIC_EXPORT_TIMEOUT: 'not-a-number',
			},
			exporterFactories: {
				metrics: () => {
					factoryCalled = true
					return new CapturingMetricExporter()
				},
			},
		},
	)
	runtime.getMeter('BillingPlugin').createCounter('billing.charges').add(2, { currency: 'HKD' })
	const scrape = await runtime.prometheus!.scrape()
	assert.match(scrape.body, /billing_charges/)
	assert.match(scrape.body, /otel_scope_name="BillingPlugin"/)
	assert.equal(factoryCalled, false)
	assert.throws(() => runtime.getTracer('Consumer'), /traces signal is disabled/)
	assert.throws(() => runtime.getLogger('Consumer'), /logs signal is disabled/)
	await runtime.shutdown()
})

test('cleans up acquired exporters after partial initialization failure', async () => {
	const spans = new CapturingSpanExporter()
	spans.shutdownError = new Error('synchronous trace shutdown failure')
	await assert.rejects(
		createOtelRuntime(
			{
				rootName: 'root',
				otlp: ['traces', 'logs'],
				prometheus: false,
				onOtlpExportState() {},
			},
			{
				env: testEnv,
				exporterFactories: {
					traces: () => spans,
					logs: () => {
						throw new Error('logs exporter initialization failed')
					},
				},
			},
		),
		/logs exporter initialization failed/,
	)
	assert.equal(spans.shutdownCalls, 1)
})

test('attempts every provider shutdown when one signal fails synchronously', async () => {
	const metrics = new CapturingMetricExporter()
	const spans = new CapturingSpanExporter()
	const logs = new CapturingLogExporter()
	metrics.shutdownError = new Error('synchronous metric shutdown failure')
	const runtime = await createOtelRuntime(
		{
			rootName: 'root',
			otlp: ['metrics', 'traces', 'logs'],
			prometheus: false,
			onOtlpExportState() {},
		},
		{
			env: testEnv,
			exporterFactories: {
				metrics: () => metrics,
				traces: () => spans,
				logs: () => logs,
			},
		},
	)
	runtime.getMeter('Consumer').createCounter('shutdown.metric').add(1)
	runtime.getTracer('Consumer').startSpan('shutdown.span').end()
	runtime.getLogger('Consumer').emit({ body: 'shutdown log' })

	await assert.rejects(runtime.shutdown(), /OpenTelemetry provider shutdown failed/)
	assert.equal(metrics.shutdownCalls, 1)
	assert.equal(spans.shutdownCalls, 1)
	assert.equal(logs.shutdownCalls, 1)
})

test('shuts down an acquired metric exporter when reader initialization fails', async () => {
	const exporter = new CapturingMetricExporter()
	await assert.rejects(
		createOtlpMetricReader({
			env: testEnv,
			factory: () => exporter,
			get onExportState(): never {
				throw new Error('diagnostic hook setup failed')
			},
		}),
		/diagnostic hook setup failed/,
	)
	assert.equal(exporter.shutdownCalls, 1)
})

test('reports exporter failures using only signal and bounded error type', async () => {
	const exporter = new CapturingMetricExporter()
	exporter.fail = true
	const states: OtlpExportState[] = []
	const runtime = await createOtelRuntime(
		{
			rootName: 'root',
			otlp: ['metrics'],
			prometheus: false,
			onOtlpExportState: (state) => states.push(state),
		},
		{
			env: testEnv,
			exporterFactories: { metrics: () => exporter },
		},
	)
	runtime.getMeter('Consumer').createCounter('requests').add(1)
	await runtime.shutdown().catch((): void => undefined)
	assert.ok(
		states.some(
			(state) =>
				state.signal === 'metrics' && 'errorType' in state && state.errorType === 'NetworkError',
		),
	)
})

type HttpRequestCapture = {
	path: string | undefined
	headers: IncomingHttpHeaders
	body: Buffer
}

async function withHttpReceiver(
	count: number,
	run: (baseUrl: string) => Promise<void>,
): Promise<HttpRequestCapture[]> {
	const requests: HttpRequestCapture[] = []
	let resolveRequests!: () => void
	const received = new Promise<void>((resolve) => {
		resolveRequests = resolve
	})
	const server = createServer((request, response) => {
		const chunks: Buffer[] = []
		request.on('data', (chunk: Buffer) => chunks.push(chunk))
		request.on('end', () => {
			requests.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks) })
			const isJson = String(request.headers['content-type']).includes('application/json')
			response.statusCode = 200
			response.setHeader('content-type', isJson ? 'application/json' : 'application/x-protobuf')
			response.end(isJson ? '{}' : undefined)
			if (requests.length === count) resolveRequests()
		})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
	try {
		await run('http://127.0.0.1:' + address.port)
		await received
		return requests
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) reject(error)
				else resolve()
			})
		})
	}
}

for (const protocol of ['http/protobuf', 'http/json'] as const) {
	test(`sends all stable signals over OTLP ${protocol}`, async () => {
		const requests = await withHttpReceiver(3, async (baseUrl) => {
			const runtime = await createOtelRuntime(
				{
					rootName: 'root',
					otlp: ['metrics', 'traces', 'logs'],
					prometheus: false,
					onOtlpExportState() {},
				},
				{
					env: {
						...testEnv,
						OTEL_SERVICE_NAME: 'integration-service',
						OTEL_EXPORTER_OTLP_ENDPOINT: baseUrl + '/otel',
						OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
						OTEL_EXPORTER_OTLP_HEADERS: 'X-Test=integration',
					},
				},
			)
			runtime.getMeter('InventoryPlugin').createCounter('inventory.changed').add(7)
			runtime.getTracer('InventoryPlugin').startSpan('inventory.refresh').end()
			runtime.getLogger('InventoryPlugin').emit({ body: 'inventory refreshed' })
			await runtime.shutdown()
		})

		assert.deepEqual(
			new Set(requests.map(({ path }) => path)),
			new Set(['/otel/v1/metrics', '/otel/v1/traces', '/otel/v1/logs']),
		)
		for (const request of requests) {
			assert.equal(request.headers['x-test'], 'integration')
			assert.ok(request.body.byteLength > 0)
			assert.ok(request.body.includes(Buffer.from('integration-service')))
			assert.ok(request.body.includes(Buffer.from('InventoryPlugin')))
			assert.match(
				String(request.headers['content-type']),
				protocol === 'http/json' ? /application\/json/ : /application\/x-protobuf/,
			)
		}
	})
}

test('honors complete VictoriaMetrics and VictoriaLogs OTLP endpoints', async () => {
	const requests = await withHttpReceiver(2, async (baseUrl) => {
		const runtime = await createOtelRuntime(
			{
				rootName: 'root',
				otlp: ['metrics', 'logs'],
				prometheus: false,
				onOtlpExportState() {},
			},
			{
				env: {
					...testEnv,
					OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: baseUrl + '/opentelemetry/v1/metrics',
					OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: baseUrl + '/insert/opentelemetry/v1/logs',
				},
			},
		)
		runtime.getMeter('VictoriaConsumer').createCounter('jobs.completed').add(1)
		runtime.getLogger('VictoriaConsumer').emit({ body: 'job completed' })
		await runtime.shutdown()
	})
	assert.deepEqual(
		new Set(requests.map(({ path }) => path)),
		new Set(['/opentelemetry/v1/metrics', '/insert/opentelemetry/v1/logs']),
	)
})

function rawUnaryService(path: string): grpc.ServiceDefinition {
	return {
		Export: {
			path,
			requestStream: false,
			responseStream: false,
			requestSerialize: (value: Buffer) => value,
			requestDeserialize: (value: Buffer) => value,
			responseSerialize: (value: Buffer) => value,
			responseDeserialize: (value: Buffer) => value,
		},
	}
}

test('sends all stable signals and resolved headers over OTLP gRPC', async () => {
	const received: Array<{ path: string; body: Buffer; testHeader: string | Buffer | undefined }> =
		[]
	let resolveReceived!: () => void
	const allReceived = new Promise<void>((resolve) => {
		resolveReceived = resolve
	})
	const server = new grpc.Server()
	for (const signal of ['metrics', 'traces', 'logs'] as const) {
		const protoPackage = signal === 'traces' ? 'trace' : signal
		const path =
			'/opentelemetry.proto.collector.' +
			protoPackage +
			'.v1.' +
			(signal === 'metrics'
				? 'MetricsService'
				: signal === 'traces'
					? 'TraceService'
					: 'LogsService') +
			'/Export'
		server.addService(rawUnaryService(path), {
			Export(
				call: grpc.ServerUnaryCall<Buffer, Buffer>,
				callback: grpc.sendUnaryData<Buffer>,
			): void {
				received.push({
					path,
					body: call.request,
					testHeader: call.metadata.get('x-test')[0],
				})
				callback(null, Buffer.alloc(0))
				if (received.length === 3) resolveReceived()
			},
		})
	}
	const port = await new Promise<number>((resolve, reject) => {
		server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
			if (error) reject(error)
			else resolve(boundPort)
		})
	})
	try {
		const runtime = await createOtelRuntime(
			{
				rootName: 'root',
				otlp: ['metrics', 'traces', 'logs'],
				prometheus: false,
				onOtlpExportState() {},
			},
			{
				env: {
					...testEnv,
					OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
					OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:' + port,
					OTEL_EXPORTER_OTLP_HEADERS: 'X-Test=grpc-integration',
				},
			},
		)
		runtime.getMeter('GrpcConsumer').createCounter('grpc.metric').add(1)
		runtime.getTracer('GrpcConsumer').startSpan('grpc.span').end()
		runtime.getLogger('GrpcConsumer').emit({ body: 'grpc log' })
		await runtime.shutdown()
		await allReceived

		assert.equal(received.length, 3)
		for (const request of received) {
			assert.ok(request.body.byteLength > 0)
			assert.ok(request.body.includes(Buffer.from('GrpcConsumer')))
			assert.equal(request.testHeader, 'grpc-integration')
		}
	} finally {
		await new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
	}
})
