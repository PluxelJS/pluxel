import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { setParamToken } from '@pluxel/core'
import { getActiveRuntimeLogging } from '@pluxel/runtime/internal'
import { RUNTIME_INTERNAL_API_BASE, RUNTIME_TRANSPORT_PATHS } from '@pluxel/runtime/web/paths'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import {
	BasePlugin,
	defineStaticRuntime,
	Plugin,
	type StaticRuntimePluginStatus,
} from '@pluxel/runtime-static'
import { createStaticRuntimeTestHost } from '@pluxel/runtime-static/test'
import * as runtimeStaticVite from '@pluxel/runtime-static/vite'

import { createStaticRuntimeHost } from '../src/internal/host'
import { runStaticNodeApplication } from '../src/internal/node-application'
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
	it('exposes a marked static application and one shared Vite source plugin group', async () => {
		const application = defineStaticRuntime({
			name: 'static-vite-config-test',
			plugins: [],
			configure: () => ({
				profile: 'test',
				runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
			}),
		})
		const plugins = runtimeStaticVite.staticRuntimeVitePlugin({
			entry: './pluxel.static.ts',
		}) as Array<{
			name?: string
			apply?: unknown
		}>

		expect(Object.keys(application)).toEqual(['name', 'plugins', 'configure'])
		expect(() =>
			defineStaticRuntime({
				name: 'static-vite-rejected',
				plugins: [],
				vite: {},
			} as never),
		).toThrow(/unsupported "vite"/i)
		expect(() =>
			defineStaticRuntime({
				name: 'static-hmr-rejected',
				plugins: [],
				hmr: {},
			} as never),
		).toThrow(/unsupported "hmr"/i)
		await expect(
			createStaticRuntimeTestHost(
				defineStaticRuntime({
					name: 'static-http-internals-rejected',
					plugins: [],
					configure: () => ({ http: { uiAssets: 'disabled' } }) as never,
				}),
			),
		).rejects.toThrow(/http must not include "uiAssets"/i)
		await expect(
			createStaticRuntimeTestHost(
				defineStaticRuntime({
					name: 'static-context-workbench-rejected',
					plugins: [],
					configure: () =>
						({
							context: { workbench: { enabled: true } },
						}) as never,
				}),
			),
		).rejects.toThrow(/context must not include "workbench"/i)
		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'unplugin-preprocessor-directives',
			'pluxel:plugin-semantics',
			'pluxel-lint-guard',
			'pluxel-config-source',
			'pluxel:static-runtime-source',
			'pluxel:static-runtime',
		])
		expect(plugins.at(-1)?.apply).toBe('serve')
		expect('defineStaticRuntime' in runtimeStaticVite).toBe(false)
	})

	it('rejects unmarked objects at every application adapter boundary', async () => {
		await expect(
			createStaticRuntimeTestHost({
				name: 'unmarked-static-application',
				plugins: [],
			} as never),
		).rejects.toThrow('must be created with defineStaticRuntime')
	})

	it('preserves application binding types and values through the test adapter', async () => {
		let bindingValue = ''
		const application = defineStaticRuntime<readonly [], { serviceUrl: string }>({
			name: 'typed-static-bindings',
			plugins: [],
			configure({ bindings }) {
				bindingValue = bindings.serviceUrl
				return {
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
				}
			},
		})
		const runtime = await createStaticRuntimeTestHost(application, {
			bindings: { serviceUrl: 'https://service.test' },
		})
		try {
			expect(bindingValue).toBe('https://service.test')
		} finally {
			await runtime.stop()
		}
	})

	it('creates a direct fetch runtime from the route-neutral config', async () => {
		@Plugin({ name: 'DirectHttp' })
		class DirectHttp extends BasePlugin {
			override init(): void {
				this.ctx.http.plugin.routes((app) => app.get('/ping', 'pong'))
				this.ctx.http.host.routes((app) => app.post('/rpc', () => 'ok'), {
					id: 'DirectHttp:public-api',
					path: '/public-api',
				})
			}
		}

		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'static-direct-fetch',
				plugins: [DirectHttp],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: {
						mode: 'memory',
						snapshot: { enabled: ['DirectHttp'] },
					},
				}),
			}),
		)
		try {
			const response = await runtime.fetch(
				new Request('http://local.test/__pluxel/plugins/DirectHttp/ping'),
			)
			const publicApi = await runtime.fetch(
				new Request('http://local.test/public-api/rpc', { method: 'POST' }),
			)
			const root = await runtime.fetch(new Request('http://local.test/'))

			expect(await response.text()).toBe('pong')
			expect(await publicApi.text()).toBe('ok')
			expect(runtime.ctx.http.matchesMountedRoute('/public-api/rpc')).toBe(true)
			expect(root.status).toBe(404)
		} finally {
			await runtime.stop()
		}
	})

	it('tears down a prepared host when application startup policy fails', async () => {
		await expect(
			createStaticRuntimeTestHost(
				defineStaticRuntime({
					name: 'static-prepare-failure',
					plugins: [],
					configure: () => ({
						configService: { mode: 'memory' },
						runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
					}),
					prepare: () => {
						throw new Error('prepare failed')
					},
				}),
			),
		).rejects.toThrow('prepare failed')
		expect(getActiveRuntimeLogging()).toBeUndefined()
	})

	it('serves internal GraphQL by default without enabling workbench UI/RPC/SSE', async () => {
		let mounted = false
		@Plugin({ name: 'HeadlessWebGate' })
		class HeadlessWebGate extends BasePlugin {
			override init(): void {
				mounted = Boolean(
					this.ctx.workbench.mount(
						workbench.extension({ contract: workbenchContract.define({}) }),
						{},
					),
				)
			}
		}

		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'static-direct-graphql',
				plugins: [HeadlessWebGate],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: ['HeadlessWebGate'] } },
					workbench: false,
				}),
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
			expect(mounted).toBe(false)
			expect(runtime.ctx.registry.isRunning(HeadlessWebGate)).toBe(true)
		} finally {
			await runtime.stop()
		}
	})

	it('applies static config fields for default runtime services without nesting them under context', async () => {
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'static-default-services',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
					persistence: { mode: 'memory' },
					pluginData: { enabled: false },
				}),
			}),
		)
		try {
			expect(runtime.ctx.root.persistence.capability).toBe('ephemeral')
			expect(runtime.ctx.config.pluginData).toEqual({ enabled: false })
			expect(runtime.ctx.config.logger?.rootId).toEqual(expect.any(String))
			expect(getActiveRuntimeLogging()?.resolved.sinks).not.toHaveProperty('store')
		} finally {
			await runtime.stop()
		}
	})

	it('installs Workbench Plane from the single host configuration boundary', async () => {
		let mounted = false
		@Plugin({ name: 'ManagedWebGate' })
		class ManagedWebGate extends BasePlugin {
			override init(): void {
				mounted = Boolean(
					this.ctx.workbench.mount(
						workbench.extension({ contract: workbenchContract.define({}) }),
						{},
					),
				)
			}
		}

		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'static-runtime-with-workbench',
				plugins: [ManagedWebGate],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: ['ManagedWebGate'] } },
					workbench: { enabled: true, access: { exposure: 'private' } },
				}),
			}),
		)
		try {
			expect(runtime.ctx.workbench.enabled).toBe(true)
			expect(getActiveRuntimeLogging()?.resolved.sinks).toHaveProperty('store')
			expect(mounted).toBe(true)
			expect(runtime.ctx.registry.isRunning(ManagedWebGate)).toBe(true)
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
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'static-explicit-vault',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
					persistence: { mode: 'memory' },
				}),
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
			defineStaticRuntime({ name: 'static-test', plugins: [StaticA, StaticB] }),
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
			defineStaticRuntime({ name: 'static-config', plugins: [InvalidConfigPlugin] }),
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
			defineStaticRuntime({ name: 'static-deps', plugins: [DepA, DepB] }),
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
			defineStaticRuntime({
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
			defineStaticRuntime({ name: 'static-failures', plugins: [StartFail, StartOk] }),
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
			defineStaticRuntime({
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
			defineStaticRuntime({ name: 'static-hmr', plugins: [HotStaticV1] }),
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
			defineStaticRuntime({ name: 'static-hmr-disabled', plugins: [DisabledHotV1] }),
			{ configService: { mode: 'memory' }, runtimeState: { mode: 'memory' } },
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({
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

	it('serves a packaged application SPA when Workbench is disabled', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-static-spa-'))
		await mkdir(resolve(root, 'public/assets'), { recursive: true })
		await writeFile(resolve(root, 'public/index.html'), '<title>Static App</title>', 'utf8')
		await writeFile(resolve(root, 'public/assets/app.js'), 'export const ready = true', 'utf8')

		const runtime = await runStaticNodeApplication(
			defineStaticRuntime({
				name: 'static-node-spa',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
					workbench: false,
				}),
			}),
			{
				env: { PLUXEL_HOST_PORT: '0' },
				deployment: { root, target: 'node', variant: 'headless' },
			},
		)

		try {
			const origin = `http://${runtime.address.host}:${runtime.address.port}`
			const page = await fetch(`${origin}/nested/route`, {
				headers: { accept: 'text/html' },
			})
			const asset = await fetch(`${origin}/assets/app.js`)
			const apiMiss = await fetch(`${origin}/not-an-api`, {
				headers: { accept: 'application/json' },
			})

			expect(page.status).toBe(200)
			expect(await page.text()).toContain('Static App')
			expect(asset.status).toBe(200)
			expect(await asset.text()).toContain('ready = true')
			expect(apiMiss.status).toBe(404)
		} finally {
			await Promise.all([runtime.stop(), runtime.stop()])
			await rm(root, { recursive: true, force: true })
		}
	})

	it('does not enable Workbench from a headless distribution', async () => {
		await expect(
			runStaticNodeApplication(
				defineStaticRuntime({
					name: 'static-headless-workbench',
					plugins: [],
					configure: () => ({
						workbench: { enabled: true, access: { exposure: 'private' } },
					}),
				}),
				{
					env: { PLUXEL_HOST_PORT: '0' },
					deployment: { root: '.', target: 'node', variant: 'headless' },
				},
			),
		).rejects.toThrow('built as headless and cannot enable Workbench')
	})
})
