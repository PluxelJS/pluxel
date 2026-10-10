import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost, defineHostApplication, envBinding, resolveHostApplication } from '@pluxel/host'
import { createElysiaHandler, elysia } from '@pluxel/services/elysia'
import { expect, it } from 'vitest'
import { OtelConfig, OtelPlugin } from '../src/index.ts'

@Plugin()
class HeadlessMeter extends BasePlugin {
	constructor(private readonly otel: OtelPlugin) {
		super()
	}
	init() {
		expect(this.ctx.workbench).toBeUndefined()
		this.otel.meter.createCounter('headless.orders').add(3)
		expect(() => this.otel.tracer).toThrow('disabled')
	}
}

it('uses the exported config schema for env-only Prometheus selection without Workbench', async () => {
	const application = defineHostApplication(() => ({
		plugins: [OtelPlugin, HeadlessMeter],
		services: [elysia()],
		state: { initial: { autoStart: [pluginNodeAddressOf(HeadlessMeter)] } },
		envBindings: [
			envBinding(OtelPlugin, {
				config: {
					schema: OtelConfig,
					mapping: { otlp: 'TELEMETRY_SIGNALS', prometheus: 'TELEMETRY_PROMETHEUS' },
				},
			}),
		],
	}))
	const resolved = await resolveHostApplication(application, {
		root: process.cwd(),
		mode: 'test',
		bindings: {},
		env: { TELEMETRY_SIGNALS: '[]', TELEMETRY_PROMETHEUS: '{"path":"/headless-metrics"}' },
	})
	const host = await createHost({
		plugins: resolved.plugins,
		services: resolved.services,
		state: resolved.state,
		config: resolved.config,
		configRecords: resolved.configRecords,
	})
	try {
		await host.start()
		const status = await host.status()
		expect(status.summary.running).toBe(2)
		const response = await createElysiaHandler(host)(
			new Request('http://localhost/headless-metrics'),
		)
		expect(response.status).toBe(200)
		expect(await response.text()).toMatch(/headless_orders_total\{[^\n]+\} 3/)
	} finally {
		await host.close()
	}
})
