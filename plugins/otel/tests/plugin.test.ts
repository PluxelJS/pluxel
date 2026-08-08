import type { Counter, Histogram, Meter, ObservableCallback, Tracer } from '@opentelemetry/api'
import type { Logger } from '@opentelemetry/api-logs'
import { PLUGIN_HTTP_BASE, v } from '@pluxel/runtime'
import { withRuntimeHost } from '@pluxel/runtime/test'
import { BasePlugin, Plugin, withHost } from '@pluxel/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OtelConfig, OtelPlugin } from '../src/index.ts'

@Plugin({ name: 'OtelConsumer' })
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

@Plugin({ name: 'SignalConsumer' })
class SignalConsumer extends BasePlugin {
	readonly tracers: Tracer[] = []
	readonly loggers: Logger[] = []

	constructor(readonly otel: OtelPlugin) {
		super()
	}

	protected override init(): void {
		this.tracers.push(this.otel.tracer, this.otel.tracer)
		this.loggers.push(this.otel.logger, this.otel.logger)
	}
}

afterEach(() => vi.unstubAllEnvs())

describe('OtelPlugin', () => {
	it('exposes native caller-scoped OTel instruments through Prometheus pull', async () => {
		vi.stubEnv('OTEL_EXPORTER_OTLP_METRICS_PROTOCOL', 'grpc')
		await withRuntimeHost(
			async (host) => {
				host.add([OtelPlugin, Consumer])
				host.cfg(OtelPlugin).set({ config: { otlp: [], prometheus: { path: '/metrics' } } })
				host.cfg(OtelPlugin).enable()
				host.cfg(Consumer).enable()
				await host.commit()

				const consumer = host.require(Consumer)
				expect(consumer.meters[0]).toBe(consumer.meters[1])
				consumer.record()

				const response = await host.ctx.http.fetch(
					new Request(`http://local.test${PLUGIN_HTTP_BASE}/OtelPlugin/metrics`),
				)
				expect(response.status).toBe(200)
				expect(response.headers.get('content-type')).toContain('text/plain')
				const body = await response.text()
				expect(body).toContain('orders_processed')
				expect(body).toContain('orders_duration')
				expect(body).toContain('queue_depth')
				expect(body).toContain('workers_active')
				expect(body).toContain('otel_scope_name="OtelConsumer"')
				expect(body).toContain('region="hk"')
				expect(body).toContain('outcome="ok"')
			},
			{ workbench: false },
		)
	})

	it('revokes the old provider view across cascade restart', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([OtelPlugin, Consumer])
				host.cfg(OtelPlugin).set({ config: { otlp: [], prometheus: {} } })
				host.cfg(OtelPlugin).enable()
				host.cfg(Consumer).enable()
				await host.commit()
				const oldConsumer = host.require(Consumer)

				host.restart(OtelPlugin, { cascadeDependents: true })
				await host.commit()

				expect(() => oldConsumer.otel.meter).toThrow(/not running/)
				expect(host.require(Consumer)).not.toBe(oldConsumer)
			},
			{ workbench: false },
		)
	})

	it('uses normal required dependency validation', async () => {
		await withHost(async (host) => {
			host.add(Consumer)
			await expect(host.commit()).rejects.toThrow(/service verification failed/)
		})
	})

	it('exposes native caller-scoped tracers and loggers without global providers', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([OtelPlugin, SignalConsumer])
				host.cfg(OtelPlugin).set({ config: { otlp: ['traces', 'logs'] } })
				host.cfg(OtelPlugin).enable()
				host.cfg(SignalConsumer).enable()
				await host.commit()

				const consumer = host.require(SignalConsumer)
				expect(consumer.tracers[0]).toBe(consumer.tracers[1])
				expect(consumer.loggers[0]).toBe(consumer.loggers[1])
				expect(() => consumer.otel.meter).toThrow(/metrics signal is disabled/)
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
