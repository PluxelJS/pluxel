import type { Workbench } from '@pluxel/workbench'
import { BasePlugin, Plugin, defineServiceRef } from '@pluxel/core'
import { defineHostApplication, envBinding, resolveHostApplication } from '@pluxel/host'
import { createResolvedHost } from '@pluxel/host/internal'
import { createElysiaHandler, elysia } from '@pluxel/services/elysia'
import { expect, it } from 'vitest'
import { Otel, OtelConfig, OtelPlugin } from '../src/index.ts'

const WorkbenchRef = defineServiceRef<Workbench>()
@Plugin()
class HeadlessMeter extends BasePlugin {
	constructor(private readonly otel: Otel) {
		super()
	}
	init() {
		expect(this.ctx.service(WorkbenchRef)).toBeUndefined()
		this.otel.meter.createCounter('headless.orders').add(3)
		expect(() => this.otel.tracer).toThrow('disabled')
	}
}

it('uses the exported config schema for env-only Prometheus selection without Workbench', async () => {
	const application = defineHostApplication(() => ({
		plugins: [
			{
				plugin: OtelPlugin,
				envBindings: [
					envBinding({
						config: {
							schema: OtelConfig,
							mapping: { otlp: 'TELEMETRY_SIGNALS', prometheus: 'TELEMETRY_PROMETHEUS' },
						},
					}),
				],
			},
			{
				plugin: HeadlessMeter,
				autoStart: true,
			},
		],
		services: [elysia()],
	}))
	const resolved = await resolveHostApplication(application, {
		root: process.cwd(),
		mode: 'test',
		bindings: {},
		env: { TELEMETRY_SIGNALS: '[]', TELEMETRY_PROMETHEUS: '{"path":"/headless-metrics"}' },
	})
	const host = await createResolvedHost(resolved)
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
