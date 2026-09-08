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
	readRuntimePluginStatusOverview,
	requireRuntimePluginGraphCoordinator,
} from '@pluxel/runtime/internal'
import { createWorkbenchBackend } from '@pluxel/runtime/internal/static'
import { defineProduct } from '@pluxel/runtime/product'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { websocket } from 'elysia/websocket'
import { workbench } from '@pluxel/runtime/workbench'
import { defineStaticRuntime, type StaticRuntimePluginStatus } from '@pluxel/runtime-static'
import { startStaticApplicationInternalTestHost } from '@pluxel/runtime-static/internal/test'
import * as runtimeStaticVite from '@pluxel/runtime-static/vite'

import { reloadStaticRuntime } from '../src/hmr'
import { createStaticRuntimeHost } from '../src/internal/host'
import { runStaticNodeApplication } from '../src/internal/node-application'
import type { StaticRuntimeHost, StaticRuntimeStartupContext } from '../src/types'
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

const HotConfigV3 = class HotConfigV3 extends BasePlugin {
	override init(): void {
		hotConfigRuns.push('v3')
	}
}

const InactiveHotV1 = class InactiveHotV1 extends BasePlugin {}

const InactiveHotV2 = class InactiveHotV2 extends BasePlugin {
	readonly config = this.configs.use(RequiredObjectSchema)
}

let managedWorkbenchMounted = false
const ManagedWorkbench = workbench.define({})

@Plugin({ displayName: 'Managed Web Gate' })
class ManagedWebGate extends BasePlugin {
	override init(): void {
		this.ctx.workbench.publish(ManagedWorkbench)
		managedWorkbenchMounted = true
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
	Plugin({ displayName: 'Hot Config Fixed' })(HotConfigV3)
	__setPluginDefinition(HotConfigV3, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: pluginDefinitionAddressOf(HotConfigV1),
	})
	lowerReplacementPair(InactiveHotV1, InactiveHotV2, 'inactive-hot', [
		'Inactive Hot',
		'Inactive Hot Replacement',
	])
	__setPluginConfig(InactiveHotV2, {
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
		this.ctx.elysia
			.get('/direct-http/ping', 'pong')
			.post('/direct-http/body', ({ request }) => request.text())
			.get('/direct-http/server', ({ request, server }) => ({
				id: server?.id,
				url: server?.url.toString(),
				port: server?.port,
				hostname: server?.hostname,
				development: server?.development,
				ip: server?.requestIP(request),
			}))
	}
}

function installOwnerWebSocket(app: BasePlugin['ctx']['elysia'], owner: 'a' | 'b'): void {
	app.use(websocket()).ws(`/owner-${owner}/socket`, {
		open(socket) {
			socket.subscribe('shared')
			socket.send(`open:${owner}`)
		},
		message(socket, message) {
			socket.publish('shared', `${owner}:topic:${message}`)
			socket.send(`${owner}:echo:${message}`)
		},
	})
}

@Plugin({ displayName: 'Static WebSocket A' })
class StaticWebSocketA extends BasePlugin {
	override init(): void {
		installOwnerWebSocket(this.ctx.elysia, 'a')
	}
}

@Plugin({ displayName: 'Static WebSocket B' })
class StaticWebSocketB extends BasePlugin {
	override init(): void {
		installOwnerWebSocket(this.ctx.elysia, 'b')
	}
}

let requestAborted = false
let responseCancelled = false

@Plugin({ displayName: 'Streaming Disconnect' })
class StreamingDisconnect extends BasePlugin {
	override init(): void {
		this.ctx.elysia.get('/streaming-disconnect/events', ({ request }) => {
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
				{ headers: { 'content-type': 'application/octet-stream' } },
			)
		})
	}
}

function addressOf(plugin: PluginConstructor): PluginNodeAddress {
	return pluginNodeAddressOf(plugin)
}

function autoStart(...plugins: PluginConstructor[]): PluginNodeAddress[] {
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

type TestWebSocket = Readonly<{
	socket: WebSocket
	messages: string[]
	nextMessage(): Promise<string>
	closed: Promise<CloseEvent>
}>

async function openTestWebSocket(url: string): Promise<TestWebSocket> {
	const socket = new WebSocket(url)
	const messages: string[] = []
	const messageWaiters: Array<(value: string) => void> = []
	const opened = Promise.withResolvers<void>()
	const closed = Promise.withResolvers<CloseEvent>()
	socket.addEventListener('open', () => opened.resolve())
	socket.addEventListener('message', (event) => {
		const value = String(event.data)
		const waiter = messageWaiters.shift()
		if (waiter) waiter(value)
		else messages.push(value)
	})
	socket.addEventListener('close', (event) => closed.resolve(event))
	socket.addEventListener('error', () => opened.reject(new Error(`WebSocket failed: ${url}`)))
	await opened.promise
	return {
		socket,
		messages,
		nextMessage: () => {
			const value = messages.shift()
			return value === undefined
				? new Promise<string>((resolve) => messageWaiters.push(resolve))
				: Promise.resolve(value)
		},
		closed: closed.promise,
	}
}

describe('@pluxel/runtime-static', () => {
	it('exposes a marked static application and one shared Vite source plugin group', async () => {
		const application = defineStaticRuntime({
			name: 'static-vite-config-test',
			plugins: [],
			configure: () => ({
				profile: 'test',
				runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
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
			'pluxel:application-recovery',
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
			startStaticApplicationInternalTestHost({ name: 'unmarked', plugins: [] } as never),
		).rejects.toThrow('must be created with defineStaticRuntime')

		let bindingValue = ''
		const runtime = await startStaticApplicationInternalTestHost(
			defineStaticRuntime({
				name: 'bindings',
				plugins: [],
				configure({ bindings }: StaticRuntimeStartupContext<{ serviceUrl: string }>) {
					bindingValue = bindings.serviceUrl
					return {
						configService: { mode: 'memory' },
						runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
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

	it.each([
		['access', { exposure: 'private' }],
		['pluginGroups', []],
	] as const)('rejects removed workbench.%s at startup', async (field, value) => {
		const application = defineStaticRuntime({
			name: `removed-workbench-${field}`,
			plugins: [],
			configure: () => ({ workbench: { enabled: true, [field]: value } }) as never,
		})

		await expect(startStaticApplicationInternalTestHost(application)).rejects.toThrow(
			new RegExp(`unsupported "${field}"`, 'i'),
		)
	})

	it('rejects unknown fields in Runtime service configuration at startup', async () => {
		const application = defineStaticRuntime({
			name: 'unknown-database-pool-field',
			plugins: [],
			configure: () =>
				({
					database: {
						driver: 'postgres',
						connectionString: 'postgres://localhost/db',
						pool: { max: 4, legacy: true },
					},
				}) as never,
		})

		await expect(startStaticApplicationInternalTestHost(application)).rejects.toThrow(
			/database\.pool includes unsupported "legacy"/i,
		)
	})

	it('uses config snapshot v3 from the reserved environment and exposes lowered schema source', async () => {
		configuredValue = undefined
		const owner = addressOf(ConfiguredPlugin)
		const runtime = await startStaticApplicationInternalTestHost(
			defineStaticRuntime({
				name: 'static-environment-config',
				plugins: [ConfiguredPlugin],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { autoStart: [owner] } },
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

	it('starts autoStart address slots and reports unknown config owners structurally', async () => {
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
				runtimeState: { mode: 'memory', snapshot: { autoStart: [addressOf(StaticA)] } },
			},
		)
		try {
			await host.start()
			expect(started).toEqual(['A'])
			expect(statusOf(host, StaticA)).toBe('started')
			expect(statusOf(host, StaticB)).toBe('stopped')
			expect(statusOf(host, ghost)).toBe('unknown-config-entry')
			expect(requirePluginService(host.ctx).isRunning(StaticA)).toBe(true)
			expect(requirePluginService(host.ctx).isRunning(StaticB)).toBe(false)
			const statusOverview = await readRuntimePluginStatusOverview(host.ctx)
			const status = statusOverview.statuses.find((entry) =>
				pluginNodeAddressEqual(entry.address, addressOf(StaticA)),
			)
			expect(status).toMatchObject({
				execution: {
					kind: 'static-catalog',
					artifact: { kind: 'unreported' },
					update: { kind: 'manual' },
				},
				recentUpdate: null,
			})
		} finally {
			await host.stop()
		}
	})

	it('reports production definitions as application-bundle deployment artifacts', async () => {
		await using fixture = await createDiskFixture()
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-deployment', plugins: [StaticA] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory' },
			},
			{
				deployment: {
					root: fixture.path,
					nodeModulesDir: fixture.getPath('artifacts/node'),
					workbenchIncluded: false,
				},
			},
		)
		try {
			await host.start()
			const statusOverview = await readRuntimePluginStatusOverview(host.ctx)
			const status = statusOverview.statuses.find((entry) =>
				pluginNodeAddressEqual(entry.address, addressOf(StaticA)),
			)
			expect(status?.execution).toEqual({
				kind: 'static-bundle',
				artifact: { kind: 'application-bundle' },
				update: { kind: 'deployment' },
			})
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
				runtimeState: { mode: 'memory', snapshot: { autoStart: [first, second] } },
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

	it('uses lowered required import provenance for dependency activation and injection', async () => {
		const consumer = addressOf(RequiredConsumer)
		const missing = await createStaticRuntimeHost(
			defineStaticRuntime({
				name: 'required-missing',
				plugins: [RequiredProvider, RequiredConsumer],
			}),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { autoStart: [consumer] } },
			},
		)
		try {
			await missing.start()
			expect(statusOf(missing, RequiredProvider)).toBe('started')
			expect(statusOf(missing, RequiredConsumer)).toBe('started')
			expect(
				requirePluginService(missing.ctx).getInstance(RequiredConsumer)?.provider,
			).toBeInstanceOf(RequiredProvider)
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
					snapshot: { autoStart: autoStart(RequiredProvider, RequiredConsumer) },
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
						autoStart: autoStart(StaticProviderA, StaticProviderB, StaticProviderConsumer),
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

	it('keeps a lowered optional edge absent-safe and restarts the consumer on provider lifecycle', async () => {
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
				runtimeState: { mode: 'memory', snapshot: { autoStart: [consumer] } },
			},
		)
		try {
			await host.start()
			expect(optionalRuns).toEqual(['consumer'])
			await requireRuntimePluginGraphCoordinator(host.ctx).startNode(provider)
			expect(optionalRuns).toEqual(['consumer', 'consumer', 'provider'])

			await requireRuntimePluginGraphCoordinator(host.ctx).stopNode(provider)
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
					snapshot: { autoStart: autoStart(InvalidConfigPlugin) },
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
						autoStart: autoStart(StartFail, StartOk, ProviderFail, ConsumerBlocked),
					},
				},
			},
		)
		try {
			await host.start()
			expect(statusOf(host, StartFail)).toBe('start-failed')
			expect(messageOf(host, StartFail)).toContain('boom')
			expect(statusOf(host, StartOk)).toBe('started')
			expect(statusOf(host, ProviderFail)).toBe('start-failed')
			expect(statusOf(host, ConsumerBlocked)).toBe('dependency-failed')
			const failed = requirePluginService(host.ctx).lastCommit?.lifecycleReport.issues.find(
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
				runtimeState: { mode: 'memory', snapshot: { autoStart: [stableAddress] } },
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
			const statusOverview = await readRuntimePluginStatusOverview(host.ctx)
			const status = statusOverview.statuses.find((entry) =>
				pluginNodeAddressEqual(entry.address, stableAddress),
			)
			expect(status?.recentUpdate).toMatchObject({
				batch: { scope: 'definitions', outcome: 'applied', phase: null, sequence: 1 },
			})
		} finally {
			await host.stop()
		}
	})

	it('reports a rejected post-commit reload as applied instead of retained', async () => {
		hotRuns.length = 0
		const stableAddress = addressOf(HotStaticV1)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr-post-commit', plugins: [HotStaticV1] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { autoStart: [stableAddress] } },
			},
		)
		const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
		const update = coordinator.update.bind(coordinator)
		const updateSpy = vi.spyOn(coordinator, 'update').mockImplementation(async (request) => {
			const report = await update(request)
			if (request.reason === 'static-hmr') throw new Error('post-commit fixture failure')
			return report
		})
		try {
			await host.start()
			await expect(
				reloadStaticRuntime({
					host,
					definition: defineStaticRuntime({
						name: 'static-hmr-post-commit',
						plugins: [HotStaticV2],
					}),
				}),
			).rejects.toThrow('post-commit fixture failure')

			expect(host.definition.plugins).toEqual([HotStaticV2])
			expect(requirePluginService(host.ctx).getInstance(stableAddress)).toBeInstanceOf(HotStaticV2)
			const statusOverview = await readRuntimePluginStatusOverview(host.ctx)
			const status = statusOverview.statuses.find((entry) =>
				pluginNodeAddressEqual(entry.address, stableAddress),
			)
			expect(status?.recentUpdate).toMatchObject({
				batch: {
					scope: 'definitions',
					outcome: 'applied-with-issues',
					phase: 'commit',
					sequence: 1,
				},
			})
		} finally {
			updateSpy.mockRestore()
			await host.stop()
		}
	})

	it('records a post-PONR report failure as an applied commit issue', async () => {
		hotRuns.length = 0
		const stableAddress = addressOf(HotStaticV1)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'static-hmr-report-failure', plugins: [HotStaticV1] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { autoStart: [stableAddress] } },
			},
		)
		try {
			await host.start()
			const reportSpy = vi
				.spyOn(host as unknown as { currentReport(): Promise<unknown> }, 'currentReport')
				.mockRejectedValueOnce(new Error('report projection fixture failure'))

			await expect(
				reloadStaticRuntime({
					host,
					definition: defineStaticRuntime({
						name: 'static-hmr-report-failure',
						plugins: [HotStaticV2],
					}),
				}),
			).rejects.toThrow('report projection fixture failure')

			expect(host.definition.plugins).toEqual([HotStaticV2])
			expect(requirePluginService(host.ctx).getInstance(stableAddress)).toBeInstanceOf(HotStaticV2)
			const statusOverview = await readRuntimePluginStatusOverview(host.ctx)
			const status = statusOverview.statuses.find((entry) =>
				pluginNodeAddressEqual(entry.address, stableAddress),
			)
			expect(status?.recentUpdate).toMatchObject({
				batch: {
					scope: 'definitions',
					outcome: 'applied-with-issues',
					phase: 'commit',
					sequence: 1,
				},
			})
			reportSpy.mockRestore()
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
				runtimeState: { mode: 'memory', snapshot: { autoStart: [stableAddress] } },
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

	it('removes an autoStart slot through the static HMR transaction', async () => {
		const address = addressOf(RemovedStatic)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'hmr-remove', plugins: [RemovedStatic] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { autoStart: [address] } },
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

	it.each([
		{ stopAfterFailure: false, expectedStatus: 'started', expectedRuns: ['v1', 'v3'] },
		{ stopAfterFailure: true, expectedStatus: 'stopped', expectedRuns: ['v1'] },
	])(
		'recovers a config-blocked source edit with stopAfterFailure=$stopAfterFailure',
		async ({ stopAfterFailure, expectedStatus, expectedRuns }) => {
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
					runtimeState: { mode: 'memory', snapshot: { autoStart: [address] } },
				},
			)
			try {
				await host.start()
				expect(hotConfigRuns).toEqual(['v1'])

				const invalid = await reloadStaticRuntime({ host, definition: nextDefinition })
				expect(invalid.replaced).toEqual([address])
				expect(statusOf(host, address)).toBe('config-invalid')
				expect(requirePluginService(host.ctx).isRunning(HotConfigV2)).toBe(false)
				const invalidStatusOverview = await readRuntimePluginStatusOverview(host.ctx)
				const invalidStatus = invalidStatusOverview.statuses.find((entry) =>
					pluginNodeAddressEqual(entry.address, address),
				)
				expect(invalidStatus?.recentUpdate).toMatchObject({
					batch: {
						scope: 'definitions',
						outcome: 'applied-with-issues',
						phase: 'lifecycle',
						sequence: 1,
					},
				})

				if (stopAfterFailure) {
					await requireRuntimePluginGraphCoordinator(host.ctx).stopNode(address)
				}
				// The next source edit fixes the schema. Recovery must not require a Start command.
				const recovered = await reloadStaticRuntime({
					host,
					definition: defineStaticRuntime({ name: 'hmr-config', plugins: [HotConfigV3] }),
				})
				expect(recovered.replaced).toEqual([address])
				expect(statusOf(host, address)).toBe(expectedStatus)
				expect(requirePluginService(host.ctx).isRunning(address)).toBe(!stopAfterFailure)
				expect(hotConfigRuns).toEqual(expectedRuns)
			} finally {
				await host.stop()
			}
		},
	)

	it('does not validate a stopped replacement generation during HMR', async () => {
		const address = addressOf(InactiveHotV1)
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'hmr-inactive', plugins: [InactiveHotV1] }),
			{ configService: { mode: 'memory' }, runtimeState: { mode: 'memory' } },
		)
		try {
			await host.start()
			const report = await reloadStaticRuntime({
				host,
				definition: defineStaticRuntime({
					name: 'hmr-inactive',
					plugins: [InactiveHotV2],
				}),
			})
			expect(report.replaced).toEqual([address])
			expect(statusOf(host, address)).toBe('stopped')
			expect(requirePluginService(host.ctx).isRunning(InactiveHotV2)).toBe(false)
		} finally {
			await host.stop()
		}
	})

	it('serves explicit Plugin HTTP when Workbench is disabled', async () => {
		const runtime = await startStaticApplicationInternalTestHost(
			defineStaticRuntime({
				name: 'static-http',
				plugins: [DirectHttp],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { autoStart: autoStart(DirectHttp) } },
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
			startStaticApplicationInternalTestHost(
				defineStaticRuntime({
					name: 'prepare-failure',
					plugins: [],
					configure: () => ({
						configService: { mode: 'memory' },
						runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
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
		const runtime = await startStaticApplicationInternalTestHost(
			defineStaticRuntime({
				name: 'default-services',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
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
		const runtime = await startStaticApplicationInternalTestHost(
			defineStaticRuntime({
				name: 'with-workbench',
				plugins: [ManagedWebGate],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: {
						mode: 'memory',
						snapshot: { autoStart: autoStart(ManagedWebGate) },
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

	it('projects the host-owned product snapshot through Cap’n Web management', async () => {
		const product = defineProduct({
			displayName: 'Rhythm',
			publisher: 'Example Company',
			legalLinks: [{ label: 'Legal', href: '/legal' }],
		})
		const host = await createStaticRuntimeHost(
			defineStaticRuntime({ name: 'product-meta', plugins: [] }),
			{
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
				workbench: { enabled: true },
			},
			{
				createWorkbenchBackend,
				product,
				requestAddress: () => ({ address: '127.0.0.1', port: 1, family: 'IPv4' }),
			},
		)
		try {
			await host.start()
			expect(host.ctx.root.runtimeManagement?.describe()).toMatchObject({
				application: { product },
			})
		} finally {
			await host.stop()
		}
	})

	it('bootstraps vault before startup after explicit import', async () => {
		await import('@pluxel/runtime/services/vault')
		const runtime = await startStaticApplicationInternalTestHost(
			defineStaticRuntime({
				name: 'explicit-vault',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
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
					runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
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

	it('keeps packaged Workbench navigation and assets ahead of the application SPA fallback', async () => {
		await using fixture = await createDiskFixture({
			'public/index.html': '<title>Static App</title>',
			'workbench/pluxel-workbench-producers.json': JSON.stringify({
				version: 1,
				profile: 1,
				buildContract: 2,
				producers: [],
			}),
			'workbench/public/.vite/manifest.json': JSON.stringify({
				'src/client.tsx': { file: 'assets/client.js', isEntry: true },
			}),
			'workbench/public/assets/client.js': 'export const ready = true',
		})
		const runtime = await runStaticNodeApplication(
			defineStaticRuntime({
				name: 'static-node-workbench-spa',
				plugins: [],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { autoStart: [] } },
					workbench: { enabled: true, uiBasePath: '/__pluxel/workbench' },
				}),
			}),
			{
				env: { PLUXEL_HOST_PORT: '0' },
				deployment: { root: fixture.path, target: 'node', variant: 'workbench' },
				createWorkbenchBackend,
			},
		)
		try {
			const origin = `http://${runtime.address.host}:${runtime.address.port}`
			const directWorkbenchPage = await runtime.fetch(
				new Request(`${origin}/__pluxel/workbench/plugins`, {
					headers: { accept: 'text/html' },
				}),
			)
			expect(await directWorkbenchPage.text()).toContain(
				'<meta name="pluxel-workbench-ui-base-path" content="/__pluxel/workbench" />',
			)
			const page = await fetch(`${origin}/nested/route`, { headers: { accept: 'text/html' } })
			expect(await page.text()).toContain('Static App')

			const workbenchPage = await fetch(`${origin}/__pluxel/workbench/plugins`, {
				headers: { accept: 'text/html' },
			})
			expect(workbenchPage.status).toBe(404)
			expect(await workbenchPage.text()).not.toContain('Static App')

			const workbenchAsset = await fetch(`${origin}/__pluxel/workbench/assets/client.js`)
			expect(workbenchAsset.status).toBe(200)
			expect(await workbenchAsset.text()).toContain('ready = true')
		} finally {
			await runtime.stop()
		}
	})

	it('round-trips a POST body through the real srvx Node listener', async () => {
		await using fixture = await createDiskFixture()
		const runtime = await runStaticNodeApplication(
			defineStaticRuntime({
				name: 'static-node-post-body',
				plugins: [DirectHttp],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { autoStart: autoStart(DirectHttp) } },
					workbench: false,
				}),
			}),
			{
				env: { PLUXEL_HOST_PORT: '0' },
				deployment: { root: fixture.path, target: 'node', variant: 'headless' },
			},
		)
		try {
			expect(runtime.address.host).toBe('0.0.0.0')
			const origin = `http://${runtime.address.host}:${runtime.address.port}`
			const response = await fetch(`${origin}/direct-http/body`, {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'body-through-srvx-and-elysia',
			})
			expect(response.status).toBe(200)
			expect(await response.text()).toBe('body-through-srvx-and-elysia')
			const server = await fetch(`${origin}/direct-http/server`)
			await expect(server.json()).resolves.toMatchObject({
				url: new URL(origin).toString(),
				port: runtime.address.port,
				hostname: runtime.address.host,
				development: false,
				ip: {
					address: '127.0.0.1',
					family: 'IPv4',
				},
			})
		} finally {
			await runtime.stop()
		}
	})

	it('serves native Elysia WebSockets per owner and drains only the stopped owner with 1012', async () => {
		await using fixture = await createDiskFixture()
		const runtime = await runStaticNodeApplication(
			defineStaticRuntime({
				name: 'static-node-websocket',
				plugins: [StaticWebSocketA, StaticWebSocketB],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: {
						mode: 'memory',
						snapshot: { autoStart: autoStart(StaticWebSocketA, StaticWebSocketB) },
					},
					workbench: false,
				}),
			}),
			{
				env: { PLUXEL_HOST_PORT: '0' },
				deployment: { root: fixture.path, target: 'node', variant: 'headless' },
			},
		)
		let ownerA1: TestWebSocket | undefined
		let ownerA2: TestWebSocket | undefined
		let ownerB: TestWebSocket | undefined
		try {
			const websocketOrigin = `ws://${runtime.address.host}:${runtime.address.port}`
			;[ownerA1, ownerA2, ownerB] = await Promise.all([
				openTestWebSocket(`${websocketOrigin}/owner-a/socket`),
				openTestWebSocket(`${websocketOrigin}/owner-a/socket`),
				openTestWebSocket(`${websocketOrigin}/owner-b/socket`),
			])
			await expect(ownerA1.nextMessage()).resolves.toBe('open:a')
			await expect(ownerA2.nextMessage()).resolves.toBe('open:a')
			await expect(ownerB.nextMessage()).resolves.toBe('open:b')

			const ownEcho = ownerA1.nextMessage()
			const sameOwnerTopic = ownerA2.nextMessage()
			ownerA1.socket.send('hello')
			await expect(ownEcho).resolves.toBe('a:echo:hello')
			await expect(sameOwnerTopic).resolves.toBe('a:topic:hello')
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(ownerB.messages).toEqual([])

			const ownerA1Closed = ownerA1.closed
			const ownerA2Closed = ownerA2.closed
			await requireRuntimePluginGraphCoordinator(runtime.ctx).stopNode(addressOf(StaticWebSocketA))
			await expect(ownerA1Closed).resolves.toMatchObject({
				code: 1012,
				reason: 'Service Restart',
			})
			await expect(ownerA2Closed).resolves.toMatchObject({
				code: 1012,
				reason: 'Service Restart',
			})

			const ownerBEcho = ownerB.nextMessage()
			ownerB.socket.send('still-running')
			await expect(ownerBEcho).resolves.toBe('b:echo:still-running')
			expect(ownerB.socket.readyState).toBe(WebSocket.OPEN)
			ownerB.socket.close()
			await ownerB.closed
		} finally {
			for (const connection of [ownerA1, ownerA2, ownerB]) {
				if (connection?.socket.readyState === WebSocket.OPEN) connection.socket.close()
			}
			await runtime.stop()
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
						snapshot: { autoStart: autoStart(StreamingDisconnect) },
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
