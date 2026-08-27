import type { Counter, Histogram, Meter, ObservableCallback } from '@opentelemetry/api'
import { formatPluginNodeReference, v } from '@pluxel/runtime'
import { withRuntimeHost } from '@pluxel/runtime/test'
import { BasePlugin, Plugin } from '@pluxel/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OtelConfig, OtelPlugin } from '../src/index.ts'

@Plugin({ displayName: 'OtelConsumer' })
class Consumer extends BasePlugin {
	private counter!: Counter
	private duration!: Histogram
	readonly meters: Meter[] = []

	constructor(readonly otel: OtelPlugin) {
		super()
	}

	protected override init(): void {
		const meter = this.otel.meter
		this.meters.push(meter, this.otel.meter)
		this.counter = meter.createCounter('orders.processed', { unit: '{order}' })
		this.duration = meter.createHistogram('orders.duration', { unit: 's' })
		meter.createGauge('queue.depth').record(3, { region: 'hk' })

		const workers = meter.createObservableGauge('workers.active')
		const observeWorkers: ObservableCallback = (result) => result.observe(2, { region: 'hk' })
		workers.addCallback(observeWorkers)
		this.ctx.effects.defer(() => workers.removeCallback(observeWorkers))
	}

	record(): void {
		this.counter.add(2, { region: 'hk', outcome: 'ok' })
		this.duration.record(0.25, { region: 'hk', outcome: 'ok' })
	}
}

afterEach(() => vi.unstubAllEnvs())

describe('OtelPlugin', () => {
	it('exposes native caller-scoped OTel instruments through Prometheus pull', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL', 'grpc')
		await withRuntimeHost(
			async (host) => {
				host.add([OtelPlugin, Consumer])
				host.cfg(OtelPlugin).set({ otlp: [], prometheus: { path: '/metrics' } })
				host.cfg(OtelPlugin).enable()
				host.cfg(Consumer).enable()
				await host.commit()

				const consumer = host.require(Consumer)
				expect(consumer.meters[0]).toBe(consumer.meters[1])
				consumer.record()

				const response = await host.fetch(new Request('http://local.test/metrics'))
				expect(response.status).toBe(200)
				expect(response.headers.get('content-type')).toContain('text/plain')
				const body = await response.text()
				expect(body).toContain('orders_processed')
				expect(body).toContain('orders_duration')
				expect(body).toContain('queue_depth')
				expect(body).toContain('workers_active')
				expect(body).toContain(
					`otel_scope_name="${formatPluginNodeReference(consumer.ctx.pluginInfo.nodeAddress)}"`,
				)
				expect(body).toContain('region="hk"')
				expect(body).toContain('outcome="ok"')
			},
			{ workbench: false },
		)
	})

	it('validates exporter selection and pull paths', () => {
		expect(v.parse(OtelConfig, {})).toEqual({
			otlp: ['metrics', 'traces', 'logs'],
			prometheus: false,
		})
		expect(v.safeParse(OtelConfig, { otlp: [] }).success).toBe(false)
		expect(v.safeParse(OtelConfig, { otlp: [], prometheus: {} }).success).toBe(true)
		expect(v.safeParse(OtelConfig, { otlp: ['logs', 'logs'] }).success).toBe(false)
		for (const path of ['/', 'metrics', '/metrics/', '/a//b', '/metrics?secret=x']) {
			expect(v.safeParse(OtelConfig, { prometheus: { path } }).success).toBe(false)
		}
	})
})
