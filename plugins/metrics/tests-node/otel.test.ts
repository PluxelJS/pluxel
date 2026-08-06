import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import test from 'node:test'
import {
	AggregationTemporality,
	DataPointType,
	InstrumentType,
	type PushMetricExporter,
	type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import {
	ATTR_OPERATION_NAME,
	ATTR_OPERATION_RESULT,
	ATTR_PLUGIN_ID,
	DURATION_BUCKETS_SECONDS,
	METRIC_CALLS,
	METRIC_CAPACITY_DROPS,
	METRIC_DURATION,
} from '../src/constants.ts'
import { resolveOtlpConfig } from '../src/env.ts'
import {
	createDefaultExporter,
	createOtlpRecorder,
	type MetricsExporterFactory,
} from '../src/otel.ts'
import type { ExportState, OperationMetric } from '../src/recorder.ts'

class CapturingExporter implements PushMetricExporter {
	readonly exports: ResourceMetrics[] = []
	fail = false
	shutdownCalls = 0

	export(
		metrics: Parameters<PushMetricExporter['export']>[0],
		resultCallback: Parameters<PushMetricExporter['export']>[1],
	): void {
		this.exports.push(metrics)
		if (this.fail) {
			resultCallback({
				code: 1,
				error: Object.assign(new Error('not exported'), { name: 'NetworkError' }),
			})
			return
		}
		resultCallback({ code: 0 })
	}

	async forceFlush(): Promise<void> {}
	async shutdown(): Promise<void> {
		this.shutdownCalls += 1
	}

	selectAggregationTemporality(): AggregationTemporality {
		return AggregationTemporality.DELTA
	}
}

function operationMetric(): OperationMetric {
	const durationAttributes = Object.freeze({
		[ATTR_PLUGIN_ID]: 'CatalogPlugin',
		[ATTR_OPERATION_NAME]: 'catalog.refresh',
	})
	return {
		pluginId: 'CatalogPlugin',
		operation: 'catalog.refresh',
		durationAttributes,
		okAttributes: Object.freeze({
			...durationAttributes,
			[ATTR_OPERATION_RESULT]: 'ok',
		}),
		errorAttributes: Object.freeze({
			...durationAttributes,
			[ATTR_OPERATION_RESULT]: 'error',
		}),
	}
}

function metricsByName(resourceMetrics: ResourceMetrics) {
	return new Map(
		resourceMetrics.scopeMetrics.flatMap(({ metrics }) =>
			metrics.map((metric) => [metric.descriptor.name, metric] as const),
		),
	)
}

test('uses fixed delta instruments, attributes, resources, and histogram buckets', async () => {
	const exporter = new CapturingExporter()
	const states: ExportState[] = []
	let collections = 0
	const factory: MetricsExporterFactory = () => exporter
	const recorder = await createOtlpRecorder(
		{
			rootName: 'root',
			hooks: {
				onCollection: () => {
					collections += 1
				},
				onExportState: (state) => states.push(state),
			},
		},
		{
			env: {
				OTEL_SERVICE_NAME: 'catalog-service',
				OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=test',
				OTEL_METRIC_EXPORT_INTERVAL: '300000',
				OTEL_METRIC_EXPORT_TIMEOUT: '5000',
			},
			exporterFactory: factory,
		},
	)

	const operation = operationMetric()
	recorder.record(operation, 'ok', 0.25)
	recorder.record(operation, 'error', 0.5)
	recorder.recordCapacityDrop('per_plugin')
	await recorder.shutdown()

	assert.ok(collections >= 1)
	assert.ok(states.some((state) => state.ok))
	const exported = exporter.exports.find(({ scopeMetrics }) => scopeMetrics.length > 0)
	assert.ok(exported)
	assert.equal(exported.resource.attributes['service.name'], 'catalog-service')
	assert.equal(exported.resource.attributes['deployment.environment.name'], 'test')

	const metrics = metricsByName(exported)
	const calls = metrics.get(METRIC_CALLS)
	const duration = metrics.get(METRIC_DURATION)
	const drops = metrics.get(METRIC_CAPACITY_DROPS)
	assert.equal(calls?.descriptor.unit, '{call}')
	assert.equal(calls?.aggregationTemporality, AggregationTemporality.DELTA)
	assert.equal(calls?.dataPoints.length, 2)
	assert.deepEqual(
		new Set(calls?.dataPoints.map(({ attributes }) => attributes[ATTR_OPERATION_RESULT])),
		new Set(['ok', 'error']),
	)

	assert.equal(duration?.descriptor.unit, 's')
	assert.equal(duration?.aggregationTemporality, AggregationTemporality.DELTA)
	assert.equal(duration?.dataPointType, DataPointType.HISTOGRAM)
	if (duration?.dataPointType !== DataPointType.HISTOGRAM) {
		throw new Error('Expected duration to use explicit histogram aggregation')
	}
	assert.deepEqual(duration.dataPoints[0]!.value.buckets.boundaries, [...DURATION_BUCKETS_SECONDS])
	assert.equal(duration.dataPoints[0]!.value.count, 2)
	assert.equal(drops?.dataPoints[0]!.attributes['pluxel.metrics.limit'], 'per_plugin')
})

test('reports successful local collections even when there is no metric data to export', async () => {
	const exporter = new CapturingExporter()
	let collections = 0
	const recorder = await createOtlpRecorder(
		{
			rootName: 'root',
			hooks: {
				onCollection: () => {
					collections += 1
				},
				onExportState() {},
			},
		},
		{
			env: {
				OTEL_METRIC_EXPORT_INTERVAL: '300000',
				OTEL_METRIC_EXPORT_TIMEOUT: '5000',
			},
			exporterFactory: () => exporter,
		},
	)

	await recorder.shutdown()

	assert.equal(collections, 1)
	assert.equal(exporter.exports.length, 0)
})

test('shuts down acquired OTel resources when recorder initialization fails', async () => {
	const exporter = new CapturingExporter()
	const input = {
		rootName: 'root',
		get hooks(): never {
			throw new Error('hook setup failed')
		},
	}

	await assert.rejects(
		createOtlpRecorder(input, {
			env: {
				OTEL_METRIC_EXPORT_INTERVAL: '300000',
				OTEL_METRIC_EXPORT_TIMEOUT: '5000',
			},
			exporterFactory: () => exporter,
		}),
		/hook setup failed/,
	)
	assert.equal(exporter.shutdownCalls, 1)
})

test('reports exporter failures using only a bounded error type', async () => {
	const exporter = new CapturingExporter()
	exporter.fail = true
	const states: ExportState[] = []
	const recorder = await createOtlpRecorder(
		{
			rootName: 'root',
			hooks: {
				onCollection() {},
				onExportState: (state) => states.push(state),
			},
		},
		{
			env: {
				OTEL_METRIC_EXPORT_INTERVAL: '300000',
				OTEL_METRIC_EXPORT_TIMEOUT: '5000',
			},
			exporterFactory: () => exporter,
		},
	)
	recorder.record(operationMetric(), 'ok', 0.1)
	await recorder.shutdown().catch((): void => undefined)
	assert.ok(states.some((state) => 'errorType' in state && state.errorType === 'NetworkError'))
})

test('configures the real OTLP exporter for delta temporality', async () => {
	const exporter = createDefaultExporter(
		resolveOtlpConfig(
			{
				OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:4318/v1/metrics',
			},
			'root',
		),
	)
	assert.equal(
		exporter.selectAggregationTemporality?.(InstrumentType.COUNTER),
		AggregationTemporality.DELTA,
	)
	await exporter.shutdown()
})

test('sends protobuf OTLP over HTTP with fixed resource and metric names', async (t) => {
	type RequestCapture = {
		path: string | undefined
		headers: IncomingHttpHeaders
		body: Buffer
	}
	let resolveRequest!: (request: RequestCapture) => void
	const received = new Promise<RequestCapture>((resolve) => {
		resolveRequest = resolve
	})
	const server = createServer((request, response) => {
		const chunks: Buffer[] = []
		request.on('data', (chunk: Buffer) => chunks.push(chunk))
		request.on('end', () => {
			resolveRequest({
				path: request.url,
				headers: request.headers,
				body: Buffer.concat(chunks),
			})
			response.statusCode = 200
			response.setHeader('content-type', 'application/x-protobuf')
			response.end()
		})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			}),
	)
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected TCP server address')

	const states: ExportState[] = []
	const recorder = await createOtlpRecorder(
		{
			rootName: 'root',
			hooks: {
				onCollection() {},
				onExportState: (state) => states.push(state),
			},
		},
		{
			env: {
				OTEL_SERVICE_NAME: 'integration-service',
				OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:' + address.port + '/v1/metrics',
				OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'X-Test=integration',
				OTEL_METRIC_EXPORT_INTERVAL: '300000',
				OTEL_METRIC_EXPORT_TIMEOUT: '5000',
			},
		},
	)
	recorder.record(operationMetric(), 'ok', 0.25)
	await recorder.shutdown()

	const request = await received
	assert.equal(request.path, '/v1/metrics')
	assert.equal(request.headers['x-test'], 'integration')
	assert.match(String(request.headers['content-type']), /application\/x-protobuf/)
	assert.ok(request.body.byteLength > 0)
	for (const value of [
		'integration-service',
		METRIC_CALLS,
		METRIC_DURATION,
		ATTR_PLUGIN_ID,
		'CatalogPlugin',
	]) {
		assert.ok(request.body.includes(Buffer.from(value)), 'missing protobuf string: ' + value)
	}
	assert.ok(states.some((state) => state.ok))
})
