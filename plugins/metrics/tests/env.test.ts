import { describe, expect, it } from 'vitest'
import { resolveOtlpConfig } from '../src/env.ts'

describe('OTLP environment', () => {
	it('uses signal-specific values and applies service identity precedence', () => {
		const config = resolveOtlpConfig(
			{
				OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://metrics.example/v1/metrics',
				OTEL_EXPORTER_OTLP_ENDPOINT: 'https://generic.example/base',
				OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'Authorization=Bearer%20secret,X-Tenant=pluxel',
				OTEL_EXPORTER_OTLP_HEADERS: 'ignored=value',
				OTEL_RESOURCE_ATTRIBUTES: 'service.name=resource,region=hk%2Ccentral',
				OTEL_SERVICE_NAME: 'metrics-service',
				OTEL_METRIC_EXPORT_INTERVAL: '5000',
				OTEL_METRIC_EXPORT_TIMEOUT: '1000',
			},
			'root-service',
		)

		expect(config).toEqual({
			endpoint: 'https://metrics.example/v1/metrics',
			headers: {
				authorization: 'Bearer secret',
				'x-tenant': 'pluxel',
			},
			resourceAttributes: {
				'service.name': 'metrics-service',
				region: 'hk,central',
			},
			intervalMs: 5_000,
			timeoutMs: 1_000,
		})
	})

	it('appends the metrics path only to a generic endpoint', () => {
		expect(
			resolveOtlpConfig(
				{
					OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otel/',
				},
				'root',
			).endpoint,
		).toBe('https://collector.example/otel/v1/metrics')
		expect(resolveOtlpConfig({}, 'root').endpoint).toBe('http://localhost:4318/v1/metrics')
	})

	it('falls back through resource service name to root name', () => {
		expect(
			resolveOtlpConfig({ OTEL_RESOURCE_ATTRIBUTES: 'service.name=resource' }, 'root')
				.resourceAttributes['service.name'],
		).toBe('resource')
		expect(resolveOtlpConfig({}, 'root').resourceAttributes['service.name']).toBe('root')
	})

	it.each([
		[{ OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'grpc' }, /only http\/protobuf/],
		[{ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'file:///tmp/metrics' }, /http: or https:/],
		[
			{ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://user:secret@example.test/metrics' },
			/URL userinfo/,
		],
		[{ OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'bad' }, /key=value/],
		[{ OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'X-A=1,x-a=2' }, /duplicates a key/],
		[{ OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'X-A=%0Avalue' }, /valid HTTP field/],
		[{ OTEL_RESOURCE_ATTRIBUTES: 'bad' }, /key=value/],
		[{ OTEL_METRIC_EXPORT_INTERVAL: '999' }, /1000 to 300000/],
		[
			{
				OTEL_METRIC_EXPORT_INTERVAL: '1000',
				OTEL_METRIC_EXPORT_TIMEOUT: '1001',
			},
			/must not exceed/,
		],
	] as const)('rejects invalid external input %#', (env, expected) => {
		expect(() => resolveOtlpConfig(env, 'root')).toThrow(expected)
	})

	it('bounds header and resource cardinality', () => {
		const headers = Array.from({ length: 33 }, (_, index) => 'x-' + index + '=v').join(',')
		const attributes = Array.from({ length: 64 }, (_, index) => 'a' + index + '=v').join(',')
		expect(() =>
			resolveOtlpConfig({ OTEL_EXPORTER_OTLP_METRICS_HEADERS: headers }, 'root'),
		).toThrow(/at most 32 entries/)
		expect(() => resolveOtlpConfig({ OTEL_RESOURCE_ATTRIBUTES: attributes }, 'root')).toThrow(
			/at most 64 entries/,
		)
	})
})
