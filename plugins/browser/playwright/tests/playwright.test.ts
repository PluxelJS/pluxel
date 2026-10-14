import { EventEmitter } from 'node:events'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { createHost, defineHostApplication, envBinding, resolveHostApplication } from '@pluxel/host'
import { vault } from '@pluxel/services/vault'
import { createTestHost } from '@pluxel/test'
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright-core'
import * as v from 'valibot'
import { beforeEach, expect, it, vi } from 'vitest'
import {
	PlaywrightConfig,
	PlaywrightNotRunningError,
	PlaywrightPlugin,
	PlaywrightVaultSchema,
} from '../src/index.ts'

const sdk = vi.hoisted(() => ({ connect: vi.fn(), nativeConnect: vi.fn() }))
vi.mock('playwright-core', () => ({
	chromium: { connectOverCDP: sdk.connect, connect: sdk.nativeConnect },
}))

class TestContext extends EventEmitter {
	close = vi.fn(async () => {
		this.emit('close')
	})
	native(): BrowserContext {
		return this as unknown as BrowserContext
	}
}
class TestBrowser extends EventEmitter {
	connected = true
	defaultContext = new TestContext()
	newContext = vi.fn(async (_options?: BrowserContextOptions) => new TestContext().native())
	close = vi.fn(async () => {
		this.connected = false
		this.emit('disconnected')
	})
	isConnected() {
		return this.connected
	}
	native(): Browser {
		return this as unknown as Browser
	}
}

@Plugin()
class Consumer extends BasePlugin {
	constructor(private readonly browser: PlaywrightPlugin) {
		super()
	}
	open(signal?: AbortSignal) {
		return this.browser.newContext({ locale: 'zh-CN' }, { signal })
	}
}

let browser: TestBrowser
beforeEach(() => {
	browser = new TestBrowser()
	sdk.connect.mockReset().mockResolvedValue(browser.native())
	sdk.nativeConnect.mockReset().mockResolvedValue(browser.native())
})
const initialConfig = { endpoint: 'ws://127.0.0.1:9222' }

it.each(['cdp', 'playwright'] as const)(
	'connects via %s and closes only owned contexts on caller stop',
	async (protocol) => {
		await using host = await createTestHost()
		await host.start(PlaywrightPlugin, { initialConfig: { ...initialConfig, protocol } })
		const consumer = await host.start(Consumer)
		const context = await consumer.open()
		const selected = protocol === 'cdp' ? sdk.connect : sdk.nativeConnect
		const other = protocol === 'cdp' ? sdk.nativeConnect : sdk.connect
		expect(selected).toHaveBeenCalledWith(initialConfig.endpoint, {
			headers: undefined,
			timeout: 30_000,
			...(protocol === 'cdp' ? { noDefaults: true } : {}),
		})
		expect(other).not.toHaveBeenCalled()
		expect(browser.newContext).toHaveBeenCalledWith({ locale: 'zh-CN' })
		expect(context).toBeInstanceOf(TestContext)
		await host.stop(Consumer)
		expect(context.close).toHaveBeenCalledOnce()
		expect(browser.close).not.toHaveBeenCalled()
		expect(browser.defaultContext.close).not.toHaveBeenCalled()
		await host.stop(PlaywrightPlugin)
		expect(browser.close).toHaveBeenCalledOnce()
		expect(browser.defaultContext.close).not.toHaveBeenCalled()
	},
)

it('releases manually closed contexts without closing them again', async () => {
	await using host = await createTestHost()
	const connector = await host.start(PlaywrightPlugin, { initialConfig })
	const context = await connector.newContext()
	await context.close()
	await host.stop(PlaywrightPlugin)
	expect(context.close).toHaveBeenCalledOnce()
})

it('preserves unknown SDK acquisition errors', async () => {
	await using host = await createTestHost()
	const connector = await host.start(PlaywrightPlugin, { initialConfig })
	const failure = new Error('native SDK defect')
	browser.newContext.mockRejectedValueOnce(failure)
	await expect(connector.newContext()).rejects.toBe(failure)
})

it('rejects after disconnection and requires explicit restart', async () => {
	await using host = await createTestHost()
	const connector = await host.start(PlaywrightPlugin, { initialConfig })
	browser.connected = false
	browser.emit('disconnected')
	await expect(connector.newContext()).rejects.toBeInstanceOf(PlaywrightNotRunningError)
	expect(sdk.connect).toHaveBeenCalledOnce()
	expect(browser.newContext).not.toHaveBeenCalled()
})

it('rejects aborted acquisition promptly and closes the late native context', async () => {
	await using host = await createTestHost()
	const connector = await host.start(PlaywrightPlugin, { initialConfig })
	const deferred = Promise.withResolvers<BrowserContext>()
	browser.newContext.mockReturnValueOnce(deferred.promise)
	const abort = new AbortController()
	const pending = connector.newContext(undefined, { signal: abort.signal })
	const reason = new Error('cancelled by consumer')
	abort.abort(reason)
	await expect(pending).rejects.toBe(reason)
	const late = new TestContext()
	deferred.resolve(late.native())
	await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce())
})

it('drains a late acquisition when the consumer stops', async () => {
	await using host = await createTestHost()
	await host.start(PlaywrightPlugin, { initialConfig })
	const consumer = await host.start(Consumer)
	const deferred = Promise.withResolvers<BrowserContext>()
	browser.newContext.mockReturnValueOnce(deferred.promise)
	const pending = consumer.open()
	const rejection = pending.then(
		(): undefined => undefined,
		(error: unknown) => error,
	)
	const stopping = host.stop(Consumer)
	expect(await rejection).toBeInstanceOf(PlaywrightNotRunningError)
	const late = new TestContext()
	deferred.resolve(late.native())
	await stopping
	expect(late.close).toHaveBeenCalledOnce()
	expect(browser.close).not.toHaveBeenCalled()
})

it('disconnects before draining provider-owned pending SDK requests', async () => {
	await using host = await createTestHost()
	const connector = await host.start(PlaywrightPlugin, { initialConfig })
	const deferred = Promise.withResolvers<BrowserContext>()
	browser.newContext.mockReturnValueOnce(deferred.promise)
	browser.close.mockImplementationOnce(async () => {
		browser.connected = false
		browser.emit('disconnected')
		deferred.reject(new Error('transport closed'))
	})
	const pending = connector.newContext()
	const rejection = pending.then(
		(): undefined => undefined,
		(error: unknown) => error,
	)
	await host.stop(PlaywrightPlugin)
	expect(await rejection).toBeInstanceOf(PlaywrightNotRunningError)
	expect(browser.close).toHaveBeenCalledOnce()
})

it('reports initialization failure without the endpoint from the native error', async () => {
	await using host = await createTestHost()
	sdk.connect.mockRejectedValueOnce(new Error('ws://internal.invalid/?token=super-secret'))
	const failure = await host.commitExpectFail((change) =>
		change.start(PlaywrightPlugin, { initialConfig }),
	)
	expect(failure.lifecycleReport.issues).toContainEqual(
		expect.objectContaining({ kind: 'start-failed' }),
	)
	expect(host.isRunning(PlaywrightPlugin)).toBe(false)
	expect(browser.newContext).not.toHaveBeenCalled()
})

it('validates the public configuration and keeps credentials outside ordinary config', () => {
	expect(v.safeParse(PlaywrightConfig, {}).success).toBe(false)
	expect(v.safeParse(PlaywrightConfig, { endpoint: 'not a URL' }).success).toBe(false)
	expect(
		v.safeParse(PlaywrightConfig, { ...initialConfig, connectionKey: 'primary' }).success,
	).toBe(false)
	expect(v.safeParse(PlaywrightConfig, { endpoint: 'ws://localhost/?token=secret' }).success).toBe(
		false,
	)
	expect(v.safeParse(PlaywrightConfig, { endpoint: 'ws://user:pass@localhost/' }).success).toBe(
		false,
	)
	expect(v.safeParse(PlaywrightConfig, { endpoint: 'file:///tmp/browser' }).success).toBe(false)
	expect(v.parse(PlaywrightConfig, { connectionKey: 'primary' })).toEqual({
		connectionKey: 'primary',
		protocol: 'cdp',
		connectTimeoutMs: 30_000,
	})
})

it('rolls back an acquired but disconnected browser during initialization', async () => {
	await using host = await createTestHost()
	browser.connected = false
	const failure = await host.commitExpectFail((change) =>
		change.start(PlaywrightPlugin, { initialConfig }),
	)
	expect(failure.lifecycleReport.issues).toContainEqual(
		expect.objectContaining({ kind: 'start-failed' }),
	)
	expect(browser.close).toHaveBeenCalledOnce()
	expect(browser.defaultContext.close).not.toHaveBeenCalled()
})

it.each(['cdp', 'playwright'] as const)(
	'loads a %s connection through real Vault env bindings without Workbench',
	async (protocol) => {
		const application = defineHostApplication(() => ({
			plugins: [PlaywrightPlugin],
			services: [vault({ backend: 'bindings' })],
			state: { initial: { autoStart: [pluginNodeAddressOf(PlaywrightPlugin)] } },
			configRecords: {
				initial: [
					{
						owner: pluginNodeAddressOf(PlaywrightPlugin),
						config: { connectionKey: 'primary', protocol },
					},
				],
			},
			envBindings: [
				envBinding(PlaywrightPlugin, {
					vault: {
						schema: PlaywrightVaultSchema,
						mapping: { primary: { endpoint: 'BROWSER_ENDPOINT', headers: 'BROWSER_HEADERS' } },
					},
				}),
			],
		}))
		const endpoint = 'wss://browser.invalid/?token=super-secret'
		const headers = { Authorization: 'Bearer secret-header' }
		const resolved = await resolveHostApplication(application, {
			root: process.cwd(),
			mode: 'test',
			bindings: {},
			env: { BROWSER_ENDPOINT: endpoint, BROWSER_HEADERS: JSON.stringify(headers) },
		})
		const host = await createHost({
			plugins: resolved.plugins,
			services: resolved.services,
			state: resolved.state,
			config: resolved.config,
			configRecords: resolved.configRecords,
			vaultBindings: resolved.vaultBindings,
		})
		try {
			await host.start()
			const status = await host.status()
			expect(status.summary.running).toBe(1)
			expect(protocol === 'cdp' ? sdk.connect : sdk.nativeConnect).toHaveBeenLastCalledWith(
				endpoint,
				{ headers, timeout: 30_000, ...(protocol === 'cdp' ? { noDefaults: true } : {}) },
			)
		} finally {
			await host.close()
		}
	},
)

it('fails safely when Vault is configured but the selected connection record is absent', async () => {
	await using host = await createTestHost({ services: [vault({ backend: 'bindings' })] })
	const result = await host.commitExpectFail((change) => {
		change.start(PlaywrightPlugin, { initialConfig: { connectionKey: 'missing' } })
	})
	expect(JSON.stringify(result.lifecycleReport)).toContain('missing or invalid')
	expect(sdk.connect).not.toHaveBeenCalled()
})

it('does not retain connection secrets in lifecycle diagnostics', async () => {
	await using host = await createTestHost()
	sdk.connect.mockRejectedValueOnce(
		new Error('Failed ws://remote/?token=super-secret with Authorization=secret-header'),
	)
	const result = await host.commitExpectFail((change) => {
		change.start(PlaywrightPlugin, { initialConfig })
	})
	const report = JSON.stringify(result.lifecycleReport)
	expect(report).toContain('CDP connection failed')
	expect(report).not.toContain('super-secret')
	expect(report).not.toContain('secret-header')
})

it('reports late cleanup failure after cancellation instead of silently losing the resource', async () => {
	await using host = await createTestHost()
	await host.start(PlaywrightPlugin, { initialConfig })
	const consumer = await host.start(Consumer)
	const deferred = Promise.withResolvers<BrowserContext>()
	browser.newContext.mockReturnValueOnce(deferred.promise)
	const abort = new AbortController()
	const pending = consumer.open(abort.signal)
	abort.abort()
	await expect(pending).rejects.toBe(abort.signal.reason)
	const late = new TestContext()
	late.close.mockRejectedValueOnce(new Error('remote context disposal failed'))
	deferred.resolve(late.native())
	await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce())
	const report = await host.commitExpectFail((change) => change.stop(Consumer))
	expect(JSON.stringify(report.lifecycleReport)).toContain('Playwright context cleanup failed')
})

it('still drains pending acquisitions when an existing context fails to close', async () => {
	await using host = await createTestHost()
	await host.start(PlaywrightPlugin, { initialConfig })
	const consumer = await host.start(Consumer)
	const context = (await consumer.open()) as unknown as TestContext
	context.close.mockRejectedValueOnce(new Error('existing close failed'))
	const deferred = Promise.withResolvers<BrowserContext>()
	browser.newContext.mockReturnValueOnce(deferred.promise)
	const pending = consumer.open()
	const rejected = pending.then(
		(): undefined => undefined,
		(error: unknown) => error,
	)
	const stopping = host.commitExpectFail((change) => change.stop(Consumer))
	expect(await rejected).toBeInstanceOf(PlaywrightNotRunningError)
	const late = new TestContext()
	deferred.resolve(late.native())
	const report = await stopping
	expect(late.close).toHaveBeenCalledOnce()
	expect(JSON.stringify(report.lifecycleReport)).toContain('context cleanup failed')
})

it('validates the explicitly selected browser protocol', () => {
	expect(
		v.safeParse(PlaywrightConfig, { endpoint: 'https://browser.invalid', protocol: 'playwright' })
			.success,
	).toBe(false)
	expect(v.safeParse(PlaywrightConfig, { ...initialConfig, protocol: 'guess' }).success).toBe(false)
	expect(
		v.safeParse(PlaywrightConfig, { endpoint: 'https://browser.invalid', protocol: 'cdp' }).success,
	).toBe(true)
})

it('reports native protocol failure safely without retrying CDP', async () => {
	await using host = await createTestHost()
	sdk.nativeConnect.mockRejectedValueOnce(new Error('428 ws://remote/?token=secret-version-token'))
	const result = await host.commitExpectFail((change) => {
		change.start(PlaywrightPlugin, { initialConfig: { ...initialConfig, protocol: 'playwright' } })
	})
	const report = JSON.stringify(result.lifecycleReport)
	expect(report).toContain('matching client/server major.minor versions')
	expect(report).not.toContain('secret-version-token')
	expect(sdk.connect).not.toHaveBeenCalled()
})

it('validates a Vault endpoint against the selected native protocol before connecting', async () => {
	const application = defineHostApplication(() => ({
		plugins: [PlaywrightPlugin],
		services: [vault({ backend: 'bindings' })],
		state: { initial: { autoStart: [pluginNodeAddressOf(PlaywrightPlugin)] } },
		configRecords: {
			initial: [
				{
					owner: pluginNodeAddressOf(PlaywrightPlugin),
					config: { connectionKey: 'primary', protocol: 'playwright' },
				},
			],
		},
		envBindings: [
			envBinding(PlaywrightPlugin, {
				vault: {
					schema: PlaywrightVaultSchema,
					mapping: { primary: { endpoint: 'BROWSER_ENDPOINT' } },
				},
			}),
		],
	}))
	const resolved = await resolveHostApplication(application, {
		root: process.cwd(),
		mode: 'test',
		bindings: {},
		env: { BROWSER_ENDPOINT: 'https://browser.invalid/?token=secret-endpoint' },
	})
	const host = await createHost({
		plugins: resolved.plugins,
		services: resolved.services,
		state: resolved.state,
		config: resolved.config,
		configRecords: resolved.configRecords,
		vaultBindings: resolved.vaultBindings,
	})
	try {
		await host.start()
		const status = await host.status()
		expect(status.summary.running).toBe(0)
		expect(sdk.nativeConnect).not.toHaveBeenCalled()
		expect(sdk.connect).not.toHaveBeenCalled()
	} finally {
		await host.close()
	}
})
