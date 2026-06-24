import { describe, expect, it, vi } from 'vitest'

import { setParamToken } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { getHmrRuntimeHandles } from '@pluxel/runtime/internal'
import {
	createStaticRuntimeHost,
	defineStaticRuntime,
	type StaticRuntimeHost,
	type StaticRuntimePluginStatus,
} from '@pluxel/runtime-static'
import { installStaticRuntimeHmr, reloadStaticRuntime } from '@pluxel/runtime-static/hmr'
import {
	shouldHandleStaticRuntimeRequest,
	staticRuntimeHostVitePlugin,
	staticRuntimeVitePlugins,
} from '@pluxel/runtime-static/vite'

function statuses(host: StaticRuntimeHost): Record<string, StaticRuntimePluginStatus> {
	const out: Record<string, StaticRuntimePluginStatus> = {}
	for (const entry of host.lastReport()?.entries ?? []) out[entry.name] = entry.status
	return out
}

function messages(host: StaticRuntimeHost): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {}
	for (const entry of host.lastReport()?.entries ?? []) out[entry.name] = entry.message
	return out
}

const RequiredStringSchema = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:runtime-static-test',
		validate(value: unknown) {
			if (typeof value === 'string') return { value }
			return {
				issues: [{ message: 'Expected string', path: [] }],
			}
		},
	},
}

@Plugin({ name: 'InvalidConfigPlugin' })
class InvalidConfigPlugin extends BasePlugin {
	value = this.configs.use(RequiredStringSchema as never)
}

const hotConfigRuns: string[] = []

@Plugin({ name: 'HotConfig' })
class HotConfigV1 extends BasePlugin {
	override init(): void {
		hotConfigRuns.push('v1')
	}
}

@Plugin({ name: 'HotConfig' })
class HotConfigV2 extends BasePlugin {
	value = this.configs.use(RequiredStringSchema as never)

	override init(): void {
		hotConfigRuns.push(`v2:${this.value}`)
	}
}

@Plugin({ name: 'DisabledHot' })
class DisabledHotV1 extends BasePlugin {}

@Plugin({ name: 'DisabledHot' })
class DisabledHotV2 extends BasePlugin {
	value = this.configs.use(RequiredStringSchema as never)
}

describe('@pluxel/runtime-static', () => {
	it('exposes the shared Vite transform stack for static hosts', () => {
		const plugins = staticRuntimeVitePlugins({ root: '/repo' }).flat() as Array<{ name?: string }>

		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'pluxel:static-runtime-transform',
			'pluxel-runtime-ui-bridge',
		])
	})

	it('matches static host requests without stealing Vite module assets', () => {
		expect(
			shouldHandleStaticRuntimeRequest({
				url: '/__pluxel/plugins/Demo/graphql',
				method: 'POST',
				headers: {},
			} as never),
		).toBe(true)
		expect(
			shouldHandleStaticRuntimeRequest({
				url: '/commercial',
				method: 'GET',
				headers: { accept: 'text/html' },
			} as never),
		).toBe(true)
		expect(
			shouldHandleStaticRuntimeRequest({
				url: '/@vite/client',
				method: 'GET',
				headers: { accept: '*/*' },
			} as never),
		).toBe(false)
		expect(
			shouldHandleStaticRuntimeRequest({
				url: '/web/client/main.tsx',
				method: 'GET',
				headers: { accept: '*/*' },
			} as never),
		).toBe(false)
	})

	it('starts and stops a static host through the Vite helper', async () => {
		let close: (() => void) | undefined
		const host = {
			definition: { name: 'vite-static-test' },
			ctx: {
				logger: { info: vi.fn() },
				http: { fetch: vi.fn() },
			},
			start: vi.fn(async () => ({
				runtime: 'vite-static-test',
				entries: [{ name: 'DemoPlugin', status: 'started' }],
			})),
			stop: vi.fn(async () => {}),
		} as unknown as StaticRuntimeHost
		const server = {
			httpServer: {
				once: vi.fn((_event: string, callback: () => void) => {
					close = callback
				}),
			},
			middlewares: { use: vi.fn() },
		}

		const plugin = staticRuntimeHostVitePlugin({
			hmr: false,
			createHost: async () => host,
		})
		const installMiddleware = await (
			plugin as unknown as {
				configureServer(input: typeof server): Promise<() => void>
			}
		).configureServer(server)
		installMiddleware()
		close?.()

		expect(host.start).toHaveBeenCalledOnce()
		expect(server.middlewares.use).toHaveBeenCalledOnce()
		expect(host.stop).toHaveBeenCalledOnce()
		expect(host.ctx.logger.info).toHaveBeenCalledWith('Static runtime Vite host ready', {
			runtime: 'vite-static-test',
			startup: ['DemoPlugin:started'],
		})
	})

	it('installs route-neutral development handles for source UI remotes', async () => {
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr-test', plugins: [] }),
			{
				configService: { mode: 'memory' },
				context: {
					http: { uiAssets: 'disabled' },
					extensionService: { enabled: false },
				},
			},
		)
		try {
			installStaticRuntimeHmr({ host })

			expect(host.ctx.config.http?.uiAssets).toBe('hmr-server')
			expect(host.ctx.config.extensionService?.enabled).toBe(true)
			expect(getHmrRuntimeHandles(host.ctx)?.extensions?.bindUiSource).toBeTypeOf('function')
			expect(() => installStaticRuntimeHmr({ host })).toThrow(/already installed/i)
		} finally {
			await host.stop()
		}
	})

	it('starts only plugins enabled by runtime config and reports unknown config entries', async () => {
		const started: string[] = []

		@Plugin({ name: 'StaticA' })
		class StaticA extends BasePlugin {
			override init(): void {
				started.push('A')
			}
		}

		@Plugin({ name: 'StaticB' })
		class StaticB extends BasePlugin {
			override init(): void {
				started.push('B')
			}
		}

		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-test', plugins: [StaticA, StaticB] }),
			{
				configService: {
					mode: 'memory',
					snapshot: {
						enabled: ['StaticA', 'Ghost'],
						plugins: { Ghost: {} },
					},
				},
			},
		)
		try {
			const report = await host.start()

			expect(started).toEqual(['A'])
			expect(report.runtime).toBe('static-test')
			expect(statuses(host)).toMatchObject({
				StaticA: 'started',
				StaticB: 'disabled',
				Ghost: 'unknown-config-entry',
			})
			expect(host.ctx.registry.isRunning(StaticA)).toBe(true)
			expect(host.ctx.registry.isRunning(StaticB)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('blocks enabled plugins with invalid config before commit', async () => {
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-config', plugins: [InvalidConfigPlugin] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { enabled: ['InvalidConfigPlugin'], plugins: { InvalidConfigPlugin: {} } },
				},
			},
		)
		try {
			await host.start()

			expect(statuses(host)).toMatchObject({
				InvalidConfigPlugin: 'config-invalid',
			})
			expect(host.ctx.registry.isRunning(InvalidConfigPlugin)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('reports dependency-missing when an enabled plugin depends on a disabled catalog plugin', async () => {
		@Plugin({ name: 'DepA' })
		class DepA extends BasePlugin {}

		@Plugin({ name: 'DepB' })
		class DepB extends BasePlugin {
			constructor(_a: DepA) {
				super()
			}
		}
		setParamToken(DepB, 0, DepA)

		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-deps', plugins: [DepA, DepB] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { enabled: ['DepB'] },
				},
			},
		)
		try {
			await host.start()

			expect(statuses(host)).toMatchObject({
				DepA: 'disabled',
				DepB: 'dependency-missing',
			})
			expect(host.ctx.registry.isRunning(DepB)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('reports start-failed without hiding independent startup results', async () => {
		@Plugin({ name: 'StartFail' })
		class StartFail extends BasePlugin {
			override init(): void {
				throw new Error('boom')
			}
		}

		@Plugin({ name: 'StartOk' })
		class StartOk extends BasePlugin {}

		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-failures', plugins: [StartFail, StartOk] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { enabled: ['StartFail', 'StartOk'] },
				},
			},
		)
		try {
			const report = await host.start()

			expect(statuses(host)).toMatchObject({
				StartFail: 'start-failed',
				StartOk: 'started',
			})
			expect(messages(host).StartFail).toContain('boom')
			expect(report.commit?.lifecycleReport.issues).toMatchObject([
				{ plugin: 'StartFail', kind: 'start-failed', phase: 'start' },
			])
			expect(host.ctx.registry.isRunning(StartFail)).toBe(false)
			expect(host.ctx.registry.isRunning(StartOk)).toBe(true)
		} finally {
			await host.stop()
		}
	})

	it('reports dependency-failed when a provider starts and fails', async () => {
		@Plugin({ name: 'ProviderFail' })
		class ProviderFail extends BasePlugin {
			override init(): void {
				throw new Error('provider unavailable')
			}
		}

		@Plugin({ name: 'ConsumerBlocked' })
		class ConsumerBlocked extends BasePlugin {
			constructor(_provider: ProviderFail) {
				super()
			}
		}
		setParamToken(ConsumerBlocked, 0, ProviderFail)

		const host = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'static-provider-fail',
				plugins: [ProviderFail, ConsumerBlocked],
			}),
			{
				configService: {
					mode: 'memory',
					snapshot: { enabled: ['ProviderFail', 'ConsumerBlocked'] },
				},
			},
		)
		try {
			await host.start()

			expect(statuses(host)).toMatchObject({
				ProviderFail: 'start-failed',
				ConsumerBlocked: 'dependency-failed',
			})
			expect(messages(host).ProviderFail).toContain('provider unavailable')
			expect(messages(host).ConsumerBlocked).toContain('ProviderFail')
			expect(host.ctx.registry.isRunning(ProviderFail)).toBe(false)
			expect(host.ctx.registry.isRunning(ConsumerBlocked)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('supports deterministic static HMR by replacing same-name plugin ctors', async () => {
		const started: string[] = []

		@Plugin({ name: 'HotStatic' })
		class HotStaticV1 extends BasePlugin {
			override init(): void {
				started.push('v1')
			}
		}

		@Plugin({ name: 'HotStatic' })
		class HotStaticV2 extends BasePlugin {
			override init(): void {
				started.push('v2')
			}
		}

		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr', plugins: [HotStaticV1] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { enabled: ['HotStatic'] },
				},
			},
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({ name: 'static-hmr', plugins: [HotStaticV2] }),
			})

			expect(report.replaced).toEqual(['HotStatic'])
			expect(started).toEqual(['v1', 'v2'])
			expect(statuses(host)).toMatchObject({ HotStatic: 'started' })
			expect(host.ctx.registry.getInstance(HotStaticV1)).toBeInstanceOf(HotStaticV2)
			expect(host.ctx.registry.isRunning(HotStaticV2)).toBe(true)
		} finally {
			await host.stop()
		}
	})

	it('reports catalog drift and stops removed enabled plugins during static HMR', async () => {
		@Plugin({ name: 'RemovedStatic' })
		class RemovedStatic extends BasePlugin {}

		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr-remove', plugins: [RemovedStatic] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { enabled: ['RemovedStatic'] },
				},
			},
		)
		try {
			await host.start()
			expect(host.ctx.registry.isRunning(RemovedStatic)).toBe(true)

			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({ name: 'static-hmr-remove', plugins: [] }),
			})

			expect(report.removed).toEqual(['RemovedStatic'])
			expect(statuses(host)).toMatchObject({
				RemovedStatic: 'catalog-drift',
			})
			expect(host.ctx.registry.isRunning(RemovedStatic)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('keeps static HMR retryable when the next same-name ctor has invalid config', async () => {
		hotConfigRuns.length = 0
		const nextDefinition = defineStaticRuntime({
			name: 'static-hmr-config',
			plugins: [HotConfigV2],
		})
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr-config', plugins: [HotConfigV1] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { enabled: ['HotConfig'], plugins: { HotConfig: {} } },
				},
			},
		)
		try {
			await host.start()
			expect(hotConfigRuns).toEqual(['v1'])

			const invalid = await reloadStaticRuntime({ host, definition: nextDefinition })
			expect(invalid.replaced).toEqual(['HotConfig'])
			expect(statuses(host)).toMatchObject({ HotConfig: 'config-invalid' })
			expect(host.ctx.registry.isRunning(HotConfigV1)).toBe(false)
			expect(host.ctx.registry.isRunning(HotConfigV2)).toBe(false)
			expect(hotConfigRuns).toEqual(['v1'])

			host.ctx.configService.patchConfig('HotConfig', { value: 'ok' })
			const recovered = await reloadStaticRuntime({ host, definition: nextDefinition })

			expect(recovered.replaced).toEqual([])
			expect(statuses(host)).toMatchObject({ HotConfig: 'started' })
			expect(host.ctx.registry.isRunning(HotConfigV2)).toBe(true)
			expect(hotConfigRuns).toEqual(['v1', 'v2:ok'])
		} finally {
			await host.stop()
		}
	})

	it('does not validate disabled plugins during static HMR', async () => {
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr-disabled', plugins: [DisabledHotV1] }),
			{ configService: { mode: 'memory', snapshot: { enabled: [] } } },
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({ name: 'static-hmr-disabled', plugins: [DisabledHotV2] }),
			})

			expect(report.replaced).toEqual(['DisabledHot'])
			expect(statuses(host)).toMatchObject({ DisabledHot: 'disabled' })
			expect(host.ctx.registry.isRunning(DisabledHotV2)).toBe(false)
		} finally {
			await host.stop()
		}
	})
})
