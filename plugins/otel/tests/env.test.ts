import { describe, expect, it } from 'vitest'
import {
	resolveBatchProcessorConfig,
	resolveMetricReaderConfig,
	resolveOtlpConfig,
	resolveResourceAttributes,
} from '../src/env.ts'

describe('OpenTelemetry environment', () => {
	it('resolves every stable signal and OTLP transport', () => {
		const env = {
			OTEL_EXPORTER_OTLP_ENDPOINT: 'https://generic.example/base',
			OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20generic,X-Common=yes',
			OTEL_EXPORTER_OTLP_TIMEOUT: '9000',
			OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://metrics.example/custom',
			OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'Authorization=Bearer%20metrics',
			OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
			OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'grpc',
			OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs.example:4317',
		}

		expect(resolveOtlpConfig(env, 'metrics')).toEqual({
			signal: 'metrics',
			protocol: 'http/protobuf',
			endpoint: 'https://metrics.example/custom',
			headers: { authorization: 'Bearer metrics', 'x-common': 'yes' },
			timeoutMs: 9_000,
			compression: 'gzip',
		})
		expect(resolveOtlpConfig(env, 'traces')).toMatchObject({
			signal: 'traces',
			protocol: 'http/json',
			endpoint: 'https://generic.example/base/v1/traces',
		})
		expect(resolveOtlpConfig(env, 'logs')).toMatchObject({
			signal: 'logs',
			protocol: 'grpc',
			endpoint: 'http://logs.example:4317',
		})
	})

	it('uses protocol-specific defaults and endpoint path rules', () => {
		expect(resolveOtlpConfig({}, 'metrics').endpoint).toBe('http://localhost:4318/v1/metrics')
		expect(resolveOtlpConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, 'traces').endpoint).toBe(
			'http://localhost:4317',
		)
		expect(
			resolveOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otel/' }, 'logs')
				.endpoint,
		).toBe('https://collector.example/otel/v1/logs')
		expect(
			resolveOtlpConfig(
				{
					OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
					OTEL_EXPORTER_OTLP_ENDPOINT: 'collector.example:4317',
				},
				'traces',
			).endpoint,
		).toBe('collector.example:4317')
	})

	it('resolves metric and bounded batch processor settings', () => {
		expect(
			resolveMetricReaderConfig({
				OTEL_METRIC_EXPORT_INTERVAL: '5000',
				OTEL_METRIC_EXPORT_TIMEOUT: '1000',
			}),
		).toEqual({ intervalMs: 5_000, timeoutMs: 1_000 })
		expect(
			resolveBatchProcessorConfig(
				{
					OTEL_BLRP_MAX_QUEUE_SIZE: '1000',
					OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: '100',
					OTEL_BLRP_SCHEDULE_DELAY: '250',
					OTEL_BLRP_EXPORT_TIMEOUT: '2000',
				},
				'logs',
			),
		).toEqual({
			maxQueueSize: 1_000,
			maxExportBatchSize: 100,
			scheduledDelayMillis: 250,
			exportTimeoutMillis: 2_000,
		})
	})

	it('applies resource service identity precedence independently of exporters', () => {
		expect(
			resolveResourceAttributes(
				{
					OTEL_RESOURCE_ATTRIBUTES: 'service.name=resource,region=hk%2Ccentral',
					OTEL_SERVICE_NAME: 'explicit',
				},
				'root',
			),
		).toEqual({ 'service.name': 'explicit', region: 'hk,central' })
		expect(resolveResourceAttributes({}, 'root')['service.name']).toBe('root')
	})

	it.each([
		[
			{ OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/xml' },
			'metrics' as const,
			/grpc, http\/protobuf, or http\/json/,
		],
		[
			{ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'file:///tmp/traces' },
			'traces' as const,
			/http: or https:/,
		],
		[
			{ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://user:secret@example.test/logs' },
			'logs' as const,
			/URL userinfo/,
		],
		[{ OTEL_EXPORTER_OTLP_HEADERS: 'bad' }, 'metrics' as const, /key=value/],
		[{ OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'X-A=1,x-a=2' }, 'metrics' as const, /duplicates a key/],
		[{ OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'X-A=%0Avalue' }, 'logs' as const, /valid field/],
		[{ OTEL_EXPORTER_OTLP_COMPRESSION: 'zstd' }, 'traces' as const, /none or gzip/],
	] as const)('rejects invalid OTLP input %#', (env, signal, expected) => {
		expect(() => resolveOtlpConfig(env, signal)).toThrow(expected)
	})

	it('rejects unbounded queues, batches, headers, and resource cardinality', () => {
		expect(() =>
			resolveBatchProcessorConfig(
				{ OTEL_BSP_MAX_QUEUE_SIZE: '2', OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '3' },
				'traces',
			),
		).toThrow(/must not exceed/)
		const headers = Array.from({ length: 33 }, (_, index) => 'x-' + index + '=v').join(',')
		const attributes = Array.from({ length: 64 }, (_, index) => 'a' + index + '=v').join(',')
		expect(() => resolveOtlpConfig({ OTEL_EXPORTER_OTLP_HEADERS: headers }, 'metrics')).toThrow(
			/at most 32 entries/,
		)
		expect(() =>
			resolveResourceAttributes({ OTEL_RESOURCE_ATTRIBUTES: attributes }, 'root'),
		).toThrow(/at most 64 entries/)
	})
})
