import { createDiskFixture } from '@pluxel/test/fixtures'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
	formatPluginNodeReference,
	pluginDefinitionAddressOf,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import {
	__setPluginConfig,
	__setPluginDefinition,
	PLUGIN_LOWERING_ABI_VERSION,
} from '@pluxel/test/unsafe'
import {
	getActiveRuntimeLogging,
	requireRuntimePluginGraphCoordinator,
	RUNTIME_INTERNAL_API_BASE,
	runtimeStatePatch,
} from '@pluxel/runtime/internal'
import { createWorkbenchBackend } from '@pluxel/runtime/internal/static'
import { defineProduct } from '@pluxel/runtime/product'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { defineStaticRuntime, type StaticRuntimePluginStatus } from '@pluxel/runtime-static'
import { createStaticRuntimeTestHost } from '@pluxel/runtime-static/test'
import * as runtimeStaticVite from '@pluxel/runtime-static/vite'

import { reloadStaticRuntime } from '../src/hmr'
import { createStaticRuntimeHost } from '../src/internal/host'
import { runStaticNodeApplication } from '../src/internal/node-application'
import type { StaticRuntimeHost } from '../src/types'
import { OptionalConsumer, OptionalProvider, optionalRuns } from './plugins/OptionalPlugins'
import { RequiredConsumer } from './plugins/RequiredConsumer'
import { RequiredProvider } from './plugins/RequiredProvider'
import { SharedPlugin as SharedPluginA } from './plugins/SharedA'
import { SharedPlugin as SharedPluginB } from './plugins/SharedB'

const RequiredObjectSchema: StandardSchemaV1<unknown, { value: string }> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:runtime-static-test',
		validate(value: unknown) {
			if (
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				typeof (value as { value?: unknown }).value === 'string'
			) {
				return { value: { value: (value as { value: string }).value } }
			}
			return {
				issues: [{ message: 'Expected an object with a string value', path: ['value'] }],
			}
		},
	},
}

let configuredValue: string | undefined

@Plugin({ displayName: 'Configured' })
class ConfiguredPlugin extends BasePlugin {
	readonly config = this.configs.use(RequiredObjectSchema)

	override init(): void {
		configuredValue = this.config.value
	}
}

@Plugin({ displayName: 'Invalid Config' })
class InvalidConfigPlugin extends BasePlugin {
	readonly config = this.configs.use(RequiredObjectSchema)
}

const started: string[] = []

@Plugin({ displayName: 'Static A' })
class StaticA extends BasePlugin {
	override init(): void {
		started.push('A')
	}
}

@Plugin({ displayName: 'Static B' })
class StaticB extends BasePlugin {
	override init(): void {
		started.push('B')
	}
}

@Plugin({ displayName: 'Start Fail' })
class StartFail extends BasePlugin {
	override init(): void {
		throw new Error('boom')
	}
}

@Plugin({ displayName: 'Start Ok' })
class StartOk extends BasePlugin {}

@Plugin({ displayName: 'Provider Fail' })
class ProviderFail extends BasePlugin {
	override init(): void {
		throw new Error('provider unavailable')
	}
}

@Plugin({ displayName: 'Consumer Blocked' })
class ConsumerBlocked extends BasePlugin {
	constructor(readonly provider: ProviderFail) {
		super()
	}
}

abstract class StaticProviderToken extends BasePlugin {
	abstract readonly kind: string
}

@Plugin(StaticProviderToken, { displayName: 'Static Provider A' })
class StaticProviderA extends StaticProviderToken {
	readonly kind = 'a'
}

@Plugin(StaticProviderToken, { displayName: 'Static Provider B' })
class StaticProviderB extends StaticProviderToken {
	readonly kind = 'b'
}

@Plugin({ displayName: 'Static Provider Consumer' })
class StaticProviderConsumer extends BasePlugin {
	constructor(readonly provider: StaticProviderToken) {
		super()
	}
}

const hotRuns: string[] = []

const HotStaticV1 = class HotStaticV1 extends BasePlugin {
	override init(): void {
		hotRuns.push('v1')
	}
}

const HotStaticV2 = class HotStaticV2 extends BasePlugin {
	override init(): void {
		hotRuns.push('v2')
	}
}

const HotStaticV3 = class HotStaticV3 extends BasePlugin {
	override init(): void {
		hotRuns.push('v3')
	}
}

const hotConfigRuns: string[] = []

const HotConfigV1 = class HotConfigV1 extends BasePlugin {
	override init(): void {
		hotConfigRuns.push('v1')
	}
}

const HotConfigV2 = class HotConfigV2 extends BasePlugin {
	readonly config = this.configs.use(RequiredObjectSchema)

	override init(): void {
		hotConfigRuns.push(`v2:${this.config.value}`)
	}
}

const DisabledHotV1 = class DisabledHotV1 extends BasePlugin {}

const DisabledHotV2 = class DisabledHotV2 extends BasePlugin {
	readonly config = this.configs.use(RequiredObjectSchema)
}

let managedWorkbenchMounted = false

@Plugin({ displayName: 'Managed Web Gate' })
class ManagedWebGate extends BasePlugin {
	override init(): void {
		managedWorkbenchMounted = Boolean(
			this.ctx.workbench.mount(workbench.extension({ contract: workbenchContract.define({}) }), {}),
		)
	}
}

beforeAll(() => {
	lowerReplacementPair(HotStaticV1, HotStaticV2, 'hot-static', [
		'Hot Static',
		'Hot Static Replacement',
	])
	Plugin({ displayName: 'Hot Static Final' })(HotStaticV3)
	__setPluginDefinition(HotStaticV3, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: pluginDefinitionAddressOf(HotStaticV1),
	})
	lowerReplacementPair(HotConfigV1, HotConfigV2, 'hot-config', [
		'Hot Config',
		'Hot Config Replacement',
	])
	__setPluginConfig(HotConfigV2, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		fieldName: 'config',
		schema: RequiredObjectSchema,
	})
	lowerReplacementPair(DisabledHotV1, DisabledHotV2, 'disabled-hot', [
		'Disabled Hot',
		'Disabled Hot Replacement',
	])
	__setPluginConfig(DisabledHotV2, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		fieldName: 'config',
		schema: RequiredObjectSchema,
	})
})

function lowerReplacementPair(
	first: PluginConstructor,
	second: PluginConstructor,
	id: string,
	displayNames: readonly [string, string],
): void {
	const definition = {
		entry: { kind: 'source-entry' as const, sourceSpace: 'app', path: `pluxel-test:${id}` },
		exportName: 'Plugin',
	}
	Plugin({ displayName: displayNames[0] })(first)
	Plugin({ displayName: displayNames[1] })(second)
	for (const implementation of [first, second]) {
		__setPluginDefinition(implementation, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition,
		})
	}
}

@Plugin({ displayName: 'Removed Static' })
class RemovedStatic extends BasePlugin {}

@Plugin({ displayName: 'Direct HTTP' })
class DirectHttp extends BasePlugin {
	override init(): void {
		this.ctx.http.plugin.routes((app) => app.get('/ping', 'pong'), {
			id: 'direct-http',
			publicPath: '/direct-http',
		})
	}
}

let requestAborted = false
let responseCancelled = false

@Plugin({ displayName: 'Streaming Disconnect' })
class StreamingDisconnect extends BasePlugin {
	override init(): void {
		this.ctx.http.plugin.routes(
			(app) =>
				app.get('/events', ({ request }) => {
					request.signal.addEventListener(
						'abort',
						() => {
							requestAborted = true
						},
						{ once: true },
					)
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('ready\n'))
							},
							cancel() {
								responseCancelled = true
							},
						}),
						{ headers: { 'content-type': 'text/event-stream' } },
					)
				}),
			{ publicPath: '/streaming-disconnect', id: 'streaming-disconnect' },
		)
	}
}

function addressOf(plugin: PluginConstructor): PluginNodeAddress {
	return pluginNodeAddressOf(plugin)
}

function enabled(...plugins: PluginConstructor[]): PluginNodeAddress[] {
	return plugins.map(addressOf)
}

function statusOf(
	host: StaticRuntimeHost,
	target: PluginConstructor | PluginNodeAddress,
): StaticRuntimePluginStatus | undefined {
	const address = typeof target === 'function' ? addressOf(target) : target
	return host.lastReport()?.entries.find((entry) => pluginNodeAddressEqual(entry.address, address))
		?.status
}

function messageOf(
	host: StaticRuntimeHost,
	target: PluginConstructor | PluginNodeAddress,
): string | undefined {
	const address = typeof target === 'function' ? addressOf(target) : target
	return host.lastReport()?.entries.find((entry) => pluginNodeAddressEqual(entry.address, address))
		?.message
}

function configRecord(plugin: PluginConstructor, config: Record<string, unknown>) {
	return { owner: addressOf(plugin), config }
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
			config?: (config: { cacheDir?: string }) =>
				| {
						resolve?: { dedupe?: string[] }
						server?: { watch?: { ignored?: string[] } }
						cacheDir?: string
						[key: string]: unknown
				  }
				| undefined
		}>

		expect(Object.keys(application)).toEqual(['name', 'plugins', 'configure'])
		expect(() =>
			defineStaticRuntime({ name: 'static-vite-rejected', plugins: [], vite: {} } as never),
		).toThrow(/unsupported "vite"/i)
		expect(() =>
			defineStaticRuntime({ name: 'static-hmr-rejected', plugins: [], hmr: {} } as never),
		).toThrow(/unsupported "hmr"/i)
		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'pluxel:static-application-declaration',
			'unplugin-preprocessor-directives',
			'pluxel:database-source',
			'pluxel:plugin-semantics',
			'pluxel-lint-guard',
			'pluxel-config-source',
			'pluxel:static-runtime-source',
			'pluxel:host-modules',
			'pluxel:static-runtime',
		])
		expect(plugins.at(-1)?.apply).toBe('serve')
		expect(plugins.at(-1)?.config?.({})).toMatchObject({
			cacheDir: '.pluxel/vite/static-runtime-v2',
		})
		expect('defineStaticRuntime' in runtimeStaticVite).toBe(false)
	})

	it('rejects unmarked applications and preserves typed startup bindings', async () => {
		await expect(
			createStaticRuntimeTestHost({ name: 'unmarked', plugins: [] } as never),
		).rejects.toThrow('must be created with defineStaticRuntime')

		let bindingValue = ''
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime<readonly [], { serviceUrl: string }>({
				name: 'bindings',
				plugins: [],
				configure({ bindings }) {
					bindingValue = bindings.serviceUrl
					return {
						configService: { mode: 'memory' },
						runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
					}
				},
			}),
			{ bindings: { serviceUrl: 'https://service.test' } },
		)
		try {
			expect(bindingValue).toBe('https://service.test')
		} finally {
			await runtime.stop()
		}
	})

	it('uses config snapshot v3 from the reserved environment and exposes lowered schema source', async () => {
		configuredValue = undefined
		const owner = addressOf(ConfiguredPlugin)
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'static-environment-config',
				plugins: [ConfiguredPlugin],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [owner] } },
				}),
			}),
			{
				env: {
					PLUXEL_CONFIG: JSON.stringify({
						version: 3,
						plugins: [{ owner, config: { value: 'from-environment' } }],
					}),
				},
			},
		)
		try {
			expect(requireConfigService(runtime.ctx).getRawConfig(owner)).toEqual({
				value: 'from-environment',
			})
			expect(configuredValue).toBe('from-environment')
			const config = requireRuntimePluginGraphCoordinator(runtime.ctx)
				.catalogSnapshot()
				.entries.find((entry) =>
					pluginNodeAddressEqual({ definition: entry.address, variant: 'default' }, owner),
				)?.candidate.declaration.config
			expect(config?.fieldName).toBe('config')
			expect(config?.source?.length).toBeGreaterThan(0)
		} finally {
			await runtime.stop()
		}
	})

	it('starts enabled address slots and reports unknown config owners structurally', async () => {
		started.length = 0
		const ghost: PluginNodeAddress = {
			definition: {
				entry: { kind: 'source-entry', sourceSpace: 'app', path: 'tests/Ghost.ts' },
				exportName: 'GhostPlugin',
			},
			variant: 'default',
		}
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-test', plugins: [StaticA, StaticB] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { plugins: [{ owner: ghost, config: {} }] },
				},
				runtimeState: { mode: 'memory', snapshot: { enabled: [addressOf(StaticA)] } },
			},
		)
		try {
			await host.start()
			expect(started).toEqual(['A'])
			expect(statusOf(host, StaticA)).toBe('started')
			expect(statusOf(host, StaticB)).toBe('disabled')
			expect(statusOf(host, ghost)).toBe('unknown-config-entry')
			expect(requirePluginService(host.ctx).isRunning(StaticA)).toBe(true)
			expect(requirePluginService(host.ctx).isRunning(StaticB)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('runs same class/display names from different lowered source slots together', async () => {
		const first = addressOf(SharedPluginA)
		const second = addressOf(SharedPluginB)
		expect(SharedPluginA.name).toBe(SharedPluginB.name)
		expect(pluginNodeAddressEqual(first, second)).toBe(false)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'same-display', plugins: [SharedPluginA, SharedPluginB] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [first, second] } },
			},
		)
		try {
			await host.start()
			expect(requirePluginService(host.ctx).getInstance(SharedPluginA)?.source).toBe('a')
			expect(requirePluginService(host.ctx).getInstance(SharedPluginB)?.source).toBe('b')
			expect(host.describeCatalog().plugins.map((entry) => entry.displayName)).toEqual([
				'Shared',
				'Shared',
			])
		} finally {
			await host.stop()
		}
	})

	it('uses lowered required import provenance for preflight and injection', async () => {
		const consumer = addressOf(RequiredConsumer)
		const missing = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'required-missing',
				plugins: [RequiredProvider, RequiredConsumer],
			}),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [consumer] } },
			},
		)
		try {
			await missing.start()
			expect(statusOf(missing, RequiredProvider)).toBe('disabled')
			expect(statusOf(missing, RequiredConsumer)).toBe('dependency-missing')
		} finally {
			await missing.stop()
		}

		const running = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'required-running',
				plugins: [RequiredProvider, RequiredConsumer],
			}),
			{
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: enabled(RequiredProvider, RequiredConsumer) },
				},
			},
		)
		try {
			await running.start()
			const injected = requirePluginService(running.ctx).getInstance(RequiredConsumer)?.provider
			expect(injected).toBeInstanceOf(RequiredProvider)
			expect(injected?.source).toBe('required-provider')
		} finally {
			await running.stop()
		}
	})

	it('selects an abstract provider from structured RuntimeState defaults', async () => {
		const provider = addressOf(StaticProviderB)
		const token = pluginDefinitionAddressOf(StaticProviderToken)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'provider-default',
				plugins: [StaticProviderA, StaticProviderB, StaticProviderConsumer],
			}),
			{
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: {
						enabled: enabled(StaticProviderA, StaticProviderB, StaticProviderConsumer),
						providerDefaults: [{ token, provider }],
					},
				},
			},
		)
		try {
			await host.start()
			expect(
				requirePluginService(host.ctx).getInstance(StaticProviderConsumer)?.provider.kind,
			).toBe('b')
			expect(requirePluginService(host.ctx).isRunning(StaticProviderToken)).toBe(true)
		} finally {
			await host.stop()
		}
	})

	it('keeps a lowered optional edge absent-safe and restarts the consumer when enabled', async () => {
		optionalRuns.length = 0
		const consumer = addressOf(OptionalConsumer)
		const provider = addressOf(OptionalProvider)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'optional',
				plugins: [OptionalProvider, OptionalConsumer],
			}),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [consumer] } },
			},
		)
		try {
			await host.start()
			expect(optionalRuns).toEqual(['consumer'])
			await requireRuntimePluginGraphCoordinator(host.ctx).updateRuntimeState(
				runtimeStatePatch({ type: 'set-enabled', node: provider, enabled: true }),
			)
			expect(optionalRuns).toEqual(['consumer', 'consumer', 'provider'])

			await requireRuntimePluginGraphCoordinator(host.ctx).updateRuntimeState(
				runtimeStatePatch({ type: 'set-enabled', node: provider, enabled: false }),
			)
			expect(optionalRuns).toEqual(['consumer', 'consumer', 'provider', 'cleanup', 'consumer'])
		} finally {
			await host.stop()
		}
	})

	it('blocks invalid object config before the Core commit', async () => {
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'invalid-config', plugins: [InvalidConfigPlugin] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { plugins: [configRecord(InvalidConfigPlugin, {})] },
				},
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: enabled(InvalidConfigPlugin) },
				},
			},
		)
		try {
			await host.start()
			expect(statusOf(host, InvalidConfigPlugin)).toBe('config-invalid')
			expect(requirePluginService(host.ctx).isRunning(InvalidConfigPlugin)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('reports independent lifecycle and required-dependent failures by node address', async () => {
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'failures',
				plugins: [StartFail, StartOk, ProviderFail, ConsumerBlocked],
			}),
			{
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: {
						enabled: enabled(StartFail, StartOk, ProviderFail, ConsumerBlocked),
					},
				},
			},
		)
		try {
			const report = await host.start()
			expect(statusOf(host, StartFail)).toBe('start-failed')
			expect(messageOf(host, StartFail)).toContain('boom')
			expect(statusOf(host, StartOk)).toBe('started')
			expect(statusOf(host, ProviderFail)).toBe('start-failed')
			expect(statusOf(host, ConsumerBlocked)).toBe('dependency-failed')
			const failed = report.commit?.lifecycleReport.issues.find(
				(issue) => issue.kind === 'start-failed',
			)
			expect(failed && requirePluginService(host.ctx).nodeAddressOf(failed.plugin)).toEqual(
				addressOf(StartFail),
			)
		} finally {
			await host.stop()
		}
	})

	it('replaces a constructor generation while preserving the stable node slot', async () => {
		hotRuns.length = 0
		const stableAddress = addressOf(HotStaticV1)
		expect(addressOf(HotStaticV2)).toEqual(stableAddress)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr', plugins: [HotStaticV1] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [stableAddress] } },
			},
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({ name: 'static-hmr', plugins: [HotStaticV2] }),
			})
			expect(report.replaced).toEqual([stableAddress])
			expect(hotRuns).toEqual(['v1', 'v2'])
			expect(requirePluginService(host.ctx).getInstance(HotStaticV1)).toBeInstanceOf(HotStaticV2)
		} finally {
			await host.stop()
		}
	})

	it('serializes concurrent HMR definitions before deriving catalog revisions', async () => {
		hotRuns.length = 0
		const stableAddress = addressOf(HotStaticV1)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr-queue', plugins: [HotStaticV1] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [stableAddress] } },
			},
		)
		try {
			await host.start()
			const [second, third] = await Promise.all([
				reloadStaticRuntime({
					host,
					definition: defineStaticRuntime({
						name: 'static-hmr-queue',
						plugins: [HotStaticV2],
					}),
				}),
				reloadStaticRuntime({
					host,
					definition: defineStaticRuntime({
						name: 'static-hmr-queue',
						plugins: [HotStaticV3],
					}),
				}),
			])

			expect(second.replaced).toEqual([stableAddress])
			expect(third.replaced).toEqual([stableAddress])
			expect(hotRuns).toEqual(['v1', 'v2', 'v3'])
			expect(requirePluginService(host.ctx).getInstance(stableAddress)).toBeInstanceOf(HotStaticV3)
		} finally {
			await host.stop()
		}
	})

	it('removes an enabled slot through the static HMR transaction', async () => {
		const address = addressOf(RemovedStatic)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'hmr-remove', plugins: [RemovedStatic] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [address] } },
			},
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({ name: 'hmr-remove', plugins: [] }),
			})
			expect(report.removed).toEqual([address])
			expect(statusOf(host, address)).toBe('catalog-drift')
			expect(
				report.entries.filter((entry) => pluginNodeAddressEqual(entry.address, address)),
			).toEqual([expect.objectContaining({ address, status: 'catalog-drift' })])
			expect(requirePluginService(host.ctx).isRunning(RemovedStatic)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('keeps a config-blocked HMR generation retryable at the same node address', async () => {
		hotConfigRuns.length = 0
		const address = addressOf(HotConfigV1)
		const nextDefinition = defineStaticRuntime({
			name: 'hmr-config',
			plugins: [HotConfigV2],
		})
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'hmr-config', plugins: [HotConfigV1] }),
			{
				configService: {
					mode: 'memory',
					snapshot: { plugins: [{ owner: address, config: {} }] },
				},
				runtimeState: { mode: 'memory', snapshot: { enabled: [address] } },
			},
		)
		try {
			await host.start()
			expect(hotConfigRuns).toEqual(['v1'])

			const invalid = await reloadStaticRuntime({ host, definition: nextDefinition })
			expect(invalid.replaced).toEqual([address])
			expect(statusOf(host, address)).toBe('config-invalid')
			expect(requirePluginService(host.ctx).isRunning(HotConfigV2)).toBe(false)

			requireConfigService(host.ctx).patchConfig(address, {
				value: 'ok',
			})
			await requireRuntimePluginGraphCoordinator(host.ctx).restartNode(address)
			const recovered = await reloadStaticRuntime({ host, definition: nextDefinition })
			expect(recovered.replaced).toEqual([])
			expect(statusOf(host, address)).toBe('started')
			expect(hotConfigRuns).toEqual(['v1', 'v2:ok'])
		} finally {
			await host.stop()
		}
	})

	it('does not validate a disabled replacement generation during HMR', async () => {
		const address = addressOf(DisabledHotV1)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'hmr-disabled', plugins: [DisabledHotV1] }),
			{ configService: { mode: 'memory' }, runtimeState: { mode: 'memory' } },
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({
					name: 'hmr-disabled',
					plugins: [DisabledHotV2],
				}),
			})
			expect(report.replaced).toEqual([address])
			expect(statusOf(host, address)).toBe('disabled')
			expect(requirePluginService(host.ctx).isRunning(DisabledHotV2)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('serves explicit Plugin HTTP when Workbench is disabled', async () => {
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'static-http',
				plugins: [DirectHttp],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: enabled(DirectHttp) } },
					workbench: false,
				}),
			}),
		)
		try {
			const response = await runtime.fetch(new Request('http://local.test/direct-http/ping'))
			expect(await response.text()).toBe('pong')
		} finally {
			await runtime.stop()
		}
	})

	it('tears down a prepared host when application startup policy fails', async () => {
		await expect(
			createStaticRuntimeTestHost(
				defineStaticRuntime({
					name: 'prepare-failure',
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

	it('applies top-level defaults for runtime services', async () => {
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'default-services',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
					persistence: { mode: 'memory' },
					database: false,
				}),
			}),
		)
		try {
			expect(runtime.ctx.root.persistence.capability).toBe('ephemeral')
			expect(runtime.ctx.workbench).toBeUndefined()
			expect(getActiveRuntimeLogging()?.resolved.root.id).toEqual(expect.any(String))
			expect(getActiveRuntimeLogging()?.resolved.sinks).not.toHaveProperty('store')
		} finally {
			await runtime.stop()
		}
	})

	it('installs Workbench once at the host boundary', async () => {
		managedWorkbenchMounted = false
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'with-workbench',
				plugins: [ManagedWebGate],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: {
						mode: 'memory',
						snapshot: { enabled: enabled(ManagedWebGate) },
					},
					workbench: { enabled: true },
				}),
			}),
		)
		try {
			expect(runtime.ctx.workbench).toBeDefined()
			expect(getActiveRuntimeLogging()?.resolved.sinks).toHaveProperty('store')
			expect(managedWorkbenchMounted).toBe(true)
			expect(requirePluginService(runtime.ctx).isRunning(ManagedWebGate)).toBe(true)
		} finally {
			await runtime.stop()
		}
	})

	it('projects the host-owned product snapshot through runtime meta', async () => {
		const product = defineProduct({
			displayName: 'Rhythm',
			publisher: 'Example Company',
			legalLinks: [{ label: 'Legal', href: '/legal' }],
		})
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'product-meta', plugins: [] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
				workbench: { enabled: true },
			},
			{ createWorkbenchBackend, product },
		)
		try {
			await host.start()
			const response = await host.ctx.http.fetch(
				new Request(`http://local.test${RUNTIME_INTERNAL_API_BASE}/meta`),
			)
			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toMatchObject({ application: { product } })
		} finally {
			await host.stop()
		}
	})

	it('bootstraps vault before startup after explicit import', async () => {
		await import('@pluxel/runtime/services/vault')
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'explicit-vault',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [] } },
					persistence: { mode: 'memory' },
					vault: {},
				}),
			}),
		)
		try {
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

	it('serves a packaged application SPA when Workbench is disabled', async () => {
		await using fixture = await createDiskFixture({
			'public/index.html': '<title>Static App</title>',
			'public/assets/app.js': 'export const ready = true',
		})
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
				deployment: { root: fixture.path, target: 'node', variant: 'headless' },
			},
		)
		try {
			const origin = `http://${runtime.address.host}:${runtime.address.port}`
			const page = await fetch(`${origin}/nested/route`, {
				headers: { accept: 'text/html' },
			})
			expect(page.status).toBe(200)
			expect(await page.text()).toContain('Static App')
		} finally {
			await Promise.all([runtime.stop(), runtime.stop()])
		}
	})

	it('aborts Fetch work and cancels a streaming response when the client disconnects', async () => {
		requestAborted = false
		responseCancelled = false
		await using fixture = await createDiskFixture()
		const runtime = await runStaticNodeApplication(
			defineStaticRuntime({
				name: 'static-node-disconnect',
				plugins: [StreamingDisconnect],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: {
						mode: 'memory',
						snapshot: { enabled: enabled(StreamingDisconnect) },
					},
					workbench: false,
				}),
			}),
			{
				env: { PLUXEL_HOST_PORT: '0' },
				deployment: { root: fixture.path, target: 'node', variant: 'headless' },
			},
		)
		try {
			const controller = new AbortController()
			const origin = `http://${runtime.address.host}:${runtime.address.port}`
			const response = await fetch(`${origin}/streaming-disconnect/events`, {
				signal: controller.signal,
			})
			const reader = response.body!.getReader()
			await expect(reader.read()).resolves.toMatchObject({ done: false })
			controller.abort()
			await reader.cancel().catch(() => undefined)
			await vi.waitFor(() => {
				expect(requestAborted).toBe(true)
				expect(responseCancelled).toBe(true)
			})
		} finally {
			await runtime.stop()
		}
	})

	it('does not enable Workbench from a headless distribution', async () => {
		await expect(
			runStaticNodeApplication(
				defineStaticRuntime({
					name: 'headless-workbench',
					plugins: [],
					configure: () => ({
						workbench: { enabled: true },
					}),
				}),
				{
					env: { PLUXEL_HOST_PORT: '0' },
					deployment: { root: '.', target: 'node', variant: 'headless' },
				},
			),
		).rejects.toThrow('built as headless and cannot enable Workbench')
	})

	it('uses address-formatted diagnostics without class/display identity keys', () => {
		const address = addressOf(StaticA)
		expect(formatPluginNodeReference(address)).toContain(address.definition.exportName)
	})
})
