import { describe, expect, it } from 'vitest'

import { setParamToken } from '@pluxel/core'
import { RUNTIME_INTERNAL_API_BASE, RUNTIME_TRANSPORT_PATHS } from '@pluxel/runtime/web/paths'
import {
	BasePlugin,
	createStaticRuntime,
	defineStaticRuntimeConfig,
	Plugin,
	type StaticRuntimePluginStatus,
} from '@pluxel/runtime-static'
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'

import { createStaticRuntimeHost } from '../src/internal/host'
import { reloadStaticRuntime } from '../src/hmr'
import type { StaticRuntimeHost } from '../src/types'

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
	it('exposes a marked static runtime config and a single route plugin entry', () => {
		const config = defineStaticRuntimeConfig({
			name: 'static-vite-config-test',
			profile: 'test',
			plugins: [],
			runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
		})
		const plugins = staticRuntimeVitePlugin({ config: './pluxel.static.ts' }) as Array<{
			name?: string
			apply?: unknown
		}>

		expect(Object.keys(config)).toEqual(['name', 'profile', 'plugins', 'runtimeState'])
		expect(() =>
			defineStaticRuntimeConfig({
				name: 'static-vite-rejected',
				plugins: [],
				vite: {},
			} as never),
		).toThrow(/nested "vite" field/i)
		expect(() =>
			defineStaticRuntimeConfig({
				name: 'static-hmr-rejected',
				plugins: [],
				hmr: {},
			} as never),
		).toThrow(/must not include an "hmr" field/i)
		expect(() =>
			defineStaticRuntimeConfig({
				name: 'static-http-internals-rejected',
				plugins: [],
				http: { uiAssets: 'disabled' },
			} as never),
		).toThrow(/http must not include "uiAssets"/i)
		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'pluxel:static-runtime-source',
			'pluxel-runtime-ui-bridge',
			'pluxel:static-runtime',
		])
		expect(plugins[2]?.apply).toBe('serve')
	})

	it('creates a direct fetch runtime from the route-neutral config', async () => {
		@Plugin({ name: 'DirectHttp' })
		class DirectHttp extends BasePlugin {
			override init(): void {
				this.ctx.http.plugin.routes((app) => app.get('/ping', 'pong'))
			}
		}

		const runtime = await createStaticRuntime(
			defineStaticRuntimeConfig({
				name: 'static-direct-fetch',
				plugins: [DirectHttp],
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: ['DirectHttp'] },
				},
			}),
		)
		try {
			const response = await runtime.fetch(
				new Request('http://local.test/__pluxel/plugins/DirectHttp/ping'),
			)
			const root = await runtime.fetch(new Request('http://local.test/'))

			expect(await response.text()).toBe('pong')
			expect(root.status).toBe(404)
		} finally {
			await runtime.stop()
		}
	})

	it('serves internal GraphQL by default without enabling management UI/RPC/SSE', async () => {
		const runtime = await createStaticRuntime(
			defineStaticRuntimeConfig({
				name: 'static-direct-graphql',
				plugins: [],
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
				adminAccess: { enabled: false, exposure: 'private' },
			}),
		)
		try {
			const response = await runtime.fetch(
				new Request(
					`http://local.test${RUNTIME_INTERNAL_API_BASE}${RUNTIME_TRANSPORT_PATHS.graphql}`,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ query: '{ _empty }' }),
					},
				),
			)

			expect(response.status).toBe(200)
			const json = (await response.json()) as { data?: { _empty?: string } }
			expect(json.data?._empty).toBe('ok')
		} finally {
			await runtime.stop()
		}
	})

	it('applies static config fields for default runtime services without nesting them under context', async () => {
		const runtime = await createStaticRuntime(
			defineStaticRuntimeConfig({
				name: 'static-default-services',
				plugins: [],
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
				persistence: { mode: 'memory' },
				pluginData: { enabled: false },
				logger: { preset: 'hmr' },
			}),
		)
		try {
			expect(runtime.ctx.root.persistence.capability).toBe('ephemeral')
			expect(runtime.ctx.config.pluginData).toEqual({ enabled: false })
			expect(runtime.ctx.config.logger).toMatchObject({ preset: 'hmr' })
		} finally {
			await runtime.stop()
		}
	})

	it('fails fast when admin access is enabled without importing web-management', async () => {
		await expect(
			createStaticRuntime(
				defineStaticRuntimeConfig({
					name: 'static-management-without-web-management',
					plugins: [],
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
					adminAccess: { enabled: true, exposure: 'private' },
				}),
			),
		).rejects.toThrow(/services\/web-management/)
	})

	it('starts static admin access when web-management is explicitly imported', async () => {
		await import('@pluxel/runtime/services/web-management')
		const runtime = await createStaticRuntime(
			defineStaticRuntimeConfig({
				name: 'static-management-with-web-management',
				plugins: [],
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
				adminAccess: { enabled: true, exposure: 'private' },
			}),
		)
		try {
			expect('ext' in runtime.ctx).toBe(true)
			const response = await runtime.fetch(
				new Request(`http://local.test${RUNTIME_INTERNAL_API_BASE}`),
			)
			expect(response.status).toBeLessThan(500)
		} finally {
			await runtime.stop()
		}
	})

	it('bootstraps vault before startup after explicit import', async () => {
		await import('@pluxel/runtime/services/vault')
		const runtime = await createStaticRuntime(
			defineStaticRuntimeConfig({
				name: 'static-explicit-vault',
				plugins: [],
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
				persistence: { mode: 'memory' },
			}),
		)
		try {
			expect('vault' in runtime.ctx).toBe(true)
			const state = await runtime.ctx.root.vaultAdmin.describe()
			expect(state).toMatchObject({
				present: true,
				unlocked: true,
				unlockedBy: 'host',
				hostIdentityPresent: true,
			})
		} finally {
			await runtime.stop()
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
			defineStaticRuntimeConfig({ name: 'static-test', plugins: [StaticA, StaticB] }),
			{
				configService: {
					mode: 'memory',
					snapshot: {
						plugins: { Ghost: {} },
					},
				},
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: ['StaticA', 'Ghost'] },
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
			defineStaticRuntimeConfig({ name: 'static-config', plugins: [InvalidConfigPlugin] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { plugins: { InvalidConfigPlugin: {} } },
				},
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: ['InvalidConfigPlugin'] },
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
			defineStaticRuntimeConfig({ name: 'static-deps', plugins: [DepA, DepB] }),
			{
				configService: {
					mode: 'memory',
				},
				runtimeState: {
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

	it('resolves abstract/base provider tokens during static dependency preflight', async () => {
		abstract class UsageRecorderPlugin extends BasePlugin {}

		class UsageBillingPlugin extends UsageRecorderPlugin {}
		Plugin(UsageRecorderPlugin, { name: 'UsageBillingPlugin' })(UsageBillingPlugin)

		@Plugin({ name: 'ZhipuProviderPlugin' })
		class ZhipuProviderPlugin extends BasePlugin {
			constructor(_recorder: UsageRecorderPlugin) {
				super()
			}
		}
		setParamToken(ZhipuProviderPlugin, 0, UsageRecorderPlugin)

		const host = await createStaticRuntimeHost(
			defineStaticRuntimeConfig({
				name: 'static-abstract-provider',
				plugins: [UsageBillingPlugin, ZhipuProviderPlugin],
			}),
			{
				configService: {
					mode: 'memory',
				},
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: ['UsageBillingPlugin', 'ZhipuProviderPlugin'] },
				},
			},
		)
		try {
			await host.start()

			expect(statuses(host)).toMatchObject({
				UsageBillingPlugin: 'started',
				ZhipuProviderPlugin: 'started',
			})
			expect(host.ctx.registry.isRunning(UsageRecorderPlugin)).toBe(true)
			expect(host.ctx.registry.isRunning(ZhipuProviderPlugin)).toBe(true)
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
			defineStaticRuntimeConfig({ name: 'static-failures', plugins: [StartFail, StartOk] }),
			{
				configService: {
					mode: 'memory',
				},
				runtimeState: {
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
			defineStaticRuntimeConfig({
				name: 'static-provider-fail',
				plugins: [ProviderFail, ConsumerBlocked],
			}),
			{
				configService: {
					mode: 'memory',
				},
				runtimeState: {
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
			defineStaticRuntimeConfig({ name: 'static-hmr', plugins: [HotStaticV1] }),
			{
				configService: {
					mode: 'memory',
				},
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: ['HotStatic'] },
				},
			},
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntimeConfig({ name: 'static-hmr', plugins: [HotStaticV2] }),
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
			defineStaticRuntimeConfig({ name: 'static-hmr-remove', plugins: [RemovedStatic] }),
			{
				configService: {
					mode: 'memory',
				},
				runtimeState: {
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
				definition: defineStaticRuntimeConfig({ name: 'static-hmr-remove', plugins: [] }),
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
		const nextDefinition = defineStaticRuntimeConfig({
			name: 'static-hmr-config',
			plugins: [HotConfigV2],
		})
		const host = await createStaticRuntimeHost(
			defineStaticRuntimeConfig({ name: 'static-hmr-config', plugins: [HotConfigV1] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { plugins: { HotConfig: {} } },
				},
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: ['HotConfig'] },
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
			defineStaticRuntimeConfig({ name: 'static-hmr-disabled', plugins: [DisabledHotV1] }),
			{ configService: { mode: 'memory' }, runtimeState: { mode: 'memory' } },
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntimeConfig({
					name: 'static-hmr-disabled',
					plugins: [DisabledHotV2],
				}),
			})

			expect(report.replaced).toEqual(['DisabledHot'])
			expect(statuses(host)).toMatchObject({ DisabledHot: 'disabled' })
			expect(host.ctx.registry.isRunning(DisabledHotV2)).toBe(false)
		} finally {
			await host.stop()
		}
	})
})
