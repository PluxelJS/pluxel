import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import type { PluginConstructor } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { requireRuntimeHttpService } from '@pluxel/runtime/internal'
import type { StaticRuntimeHost } from '@pluxel/runtime-static'
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { createServer, normalizePath, type HmrContext, type Plugin as VitePlugin } from 'vite'

const root = requiredEnv('PLUXEL_VITE_SMOKE_ROOT')
const entryPath = requiredEnv('PLUXEL_VITE_SMOKE_ENTRY')
const pluginPath = requiredEnv('PLUXEL_VITE_SMOKE_PLUGIN')
const cacheDir = requiredEnv('PLUXEL_VITE_SMOKE_CACHE')

let host: StaticRuntimeHost | undefined
let startupImplementation: PluginConstructor | undefined
const plugins = staticRuntimeVitePlugin({
	entry: entryPath,
	bindings: {
		capture(value: unknown, implementation: unknown) {
			host = value as StaticRuntimeHost
			startupImplementation = implementation as PluginConstructor
		},
	},
})
const routeEntry = plugins.at(-1)
if (!routeEntry || typeof routeEntry !== 'object' || Array.isArray(routeEntry)) {
	throw new Error('static Vite route plugin is missing')
}
const routePlugin = routeEntry as VitePlugin
const server = await createServer({
	configFile: false,
	root,
	cacheDir,
	logLevel: 'silent',
	optimizeDeps: { noDiscovery: true, include: [] },
	plugins,
	server: { host: '127.0.0.1', strictPort: false },
})

await server.listen()
// This runner invokes the route hook directly so each write has one deterministic HMR operation.
// A real listener is still required for the HTTP/WebSocket assertions, but its watcher must not
// race the explicit hook and process the same file event a second time.
await server.watcher.close()

const capturedHost = host
assert.ok(capturedHost, 'static host was not captured')
const address = capturedHost
	.describeCatalog()
	.plugins.find((plugin) => plugin.address.definition.exportName === 'ViteStatic')?.address
assert.ok(address, 'startup catalog is empty')
const configuredAddress = capturedHost
	.describeCatalog()
	.plugins.find((plugin) => plugin.address.definition.exportName === 'ConfiguredPlugin')?.address
assert.ok(configuredAddress, 'configured plugin is absent from the startup catalog')
const partOwnerAddress = capturedHost
	.describeCatalog()
	.plugins.find((plugin) => plugin.address.definition.exportName === 'PartOwner')?.address
assert.ok(partOwnerAddress, 'Part owner is absent from the startup catalog')
assert.deepEqual(address.definition.entry, {
	kind: 'package-root',
	packageName: '@fixture/vite-static',
})
const east = { definition: address.definition, variant: 'fork' as const, forkId: 'east' }
const west = { definition: address.definition, variant: 'fork' as const, forkId: 'west' }
const pluginService = requirePluginService(capturedHost.ctx)
const listenerAddress = server.httpServer?.address()
assert.ok(listenerAddress && typeof listenerAddress !== 'string')
const runtimeUrl = `http://127.0.0.1:${listenerAddress.port}`
const sockets: WebSocket[] = []

try {
	const startupInstances = [address, east, west].map((node) => pluginService.getInstance(node))
	assert.ok(startupInstances[0], JSON.stringify(capturedHost.lastReport()))
	assert.deepEqual(
		startupInstances.map((instance) => Reflect.get(instance ?? {}, 'version')),
		['v1', 'v1', 'v1'],
	)
	assert.equal(
		Reflect.get(pluginService.getInstance(configuredAddress) ?? {}, 'configuredLabel'),
		'configured-through-vite',
	)
	const firstVersionResponse = await fetch(`${runtimeUrl}/configured/version`)
	assert.equal(await firstVersionResponse.text(), 'v1')
	assert.equal(
		requireRuntimeHttpService(capturedHost.ctx).matchesWebSocketRoute(
			new Request(`${runtimeUrl}/configured/socket`, {
				headers: { connection: 'Upgrade', upgrade: 'websocket' },
			}),
		),
		true,
	)
	const firstSocket = await openWebSocket(`${runtimeUrl.replace(/^http/, 'ws')}/configured/socket`)
	sockets.push(firstSocket.socket)
	assert.equal(await firstSocket.nextMessage(), 'v1')
	const firstSocketClosed = firstSocket.closed
	assert.equal(
		Reflect.get(pluginService.getInstance(partOwnerAddress) ?? {}, 'injected'),
		'part-provider-v1',
	)
	for (const instance of startupInstances) {
		assert.equal(instance?.constructor, startupImplementation)
	}

	await writeFile(pluginPath, pluginSource('v2', true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.deepEqual(
		capturedHost
			.lastReport()
			?.replaced.map((node) => node.definition.exportName)
			.sort(),
		['ConfiguredPlugin', 'PartOwner', 'PartProvider', 'ViteStatic'],
	)
	const replacementInstances = [address, east, west].map((node) => pluginService.getInstance(node))
	assert.deepEqual(
		replacementInstances.map((instance) => Reflect.get(instance ?? {}, 'version')),
		['v2', 'v2', 'v2'],
	)
	const replacementImplementation = replacementInstances[0]?.constructor
	assert.notEqual(replacementImplementation, startupImplementation)
	for (const instance of replacementInstances) {
		assert.equal(instance?.constructor, replacementImplementation)
	}
	assert.equal(
		Reflect.get(pluginService.getInstance(partOwnerAddress) ?? {}, 'injected'),
		'part-provider-v2',
	)
	const replacementVersionResponse = await fetch(`${runtimeUrl}/configured/version`)
	assert.equal(await replacementVersionResponse.text(), 'v2')
	assert.deepEqual(await firstSocketClosed, { code: 1012, reason: 'Service Restart' })
	const replacementSocket = await openWebSocket(
		`${runtimeUrl.replace(/^http/, 'ws')}/configured/socket`,
	)
	sockets.push(replacementSocket.socket)
	assert.equal(await replacementSocket.nextMessage(), 'v2')
	replacementSocket.socket.close()
	await replacementSocket.closed

	await writeFile(pluginPath, pluginSource('removed', false))
	await invokeHotUpdate(routePlugin, pluginPath)
	const removed = capturedHost.lastReport()
	assert.deepEqual(removed?.removed, [address])
	assert.ok(removed?.commit)
	assert.equal(Object.isFrozen(removed.commit), true)
	assert.equal('graph' in removed.commit, false)
	assert.equal(removed?.entries.filter((entry) => entry.status === 'catalog-drift').length, 1)
	assert.equal(removed?.entries.filter((entry) => entry.status === 'unavailable').length, 2)
	assert.equal(
		removed?.entries.some((entry) => entry.status === 'start-failed'),
		false,
	)
	assert.deepEqual(
		[address, east, west].map((node) => pluginService.getInstance(node)),
		[undefined, undefined, undefined],
	)

	await writeFile(pluginPath, pluginSource('v3', true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.equal(pluginService.isRunning(address), true)
} finally {
	for (const socket of sockets) {
		if (socket.readyState === WebSocket.OPEN) socket.close()
	}
	await server.close()
}
assert.equal(pluginService.isRunning(address), false)

async function invokeHotUpdate(route: VitePlugin, changedFile: string): Promise<void> {
	const hook = route.handleHotUpdate
	if (typeof hook !== 'function') throw new Error('static Vite hot-update hook is missing')
	await hook.call(route, {
		file: normalizePath(changedFile),
		server,
		modules: [],
		read: () => Promise.resolve(''),
		timestamp: Date.now(),
	} satisfies HmrContext)
}

function requiredEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`missing ${name}`)
	return value
}

async function openWebSocket(url: string): Promise<{
	socket: WebSocket
	nextMessage(): Promise<string>
	closed: Promise<{ code: number; reason: string }>
}> {
	const socket = new WebSocket(url)
	const messages: string[] = []
	const waiters: Array<(value: string) => void> = []
	const opened = Promise.withResolvers<void>()
	const closed = Promise.withResolvers<{ code: number; reason: string }>()
	socket.addEventListener('open', () => opened.resolve())
	socket.addEventListener('message', (event) => {
		const value = String(event.data)
		const waiter = waiters.shift()
		if (waiter) waiter(value)
		else messages.push(value)
	})
	socket.addEventListener('close', (event) =>
		closed.resolve({ code: event.code, reason: event.reason }),
	)
	socket.addEventListener('error', () => opened.reject(new Error(`WebSocket failed: ${url}`)))
	await opened.promise
	return {
		socket,
		nextMessage: () => {
			const message = messages.shift()
			return message === undefined
				? new Promise<string>((resolve) => waiters.push(resolve))
				: Promise.resolve(message)
		},
		closed: closed.promise,
	}
}

function pluginSource(version: string, available: boolean): string {
	return [
		"import { BasePlugin, Plugin, PluginPart, v } from '@pluxel/runtime'",
		"import { websocket } from 'elysia/websocket'",
		"export const ViteStaticConfig = v.object({ label: v.optional(v.string(), 'default') })",
		"@Plugin({ displayName: 'Vite static', forkable: true })",
		'export class ViteStatic extends BasePlugin {',
		'  private readonly settings = this.configs.use(ViteStaticConfig)',
		`  readonly version = ${JSON.stringify(version)}`,
		"  configuredLabel = ''",
		'  protected override init() { this.configuredLabel = this.settings.label }',
		'}',
		"export const ConfiguredPluginConfig = v.object({ label: v.optional(v.string(), 'default') })",
		'@Plugin()',
		'export class ConfiguredPlugin extends BasePlugin {',
		'  private readonly settings = this.configs.use(ConfiguredPluginConfig)',
		"  configuredLabel = ''",
		`  protected override init() { this.configuredLabel = this.settings.label; this.ctx.elysia.use(websocket()).get('/configured/version', () => ${JSON.stringify(version)}).ws('/configured/socket', { open(socket) { socket.send(${JSON.stringify(version)}) } }) }`,
		'}',
		'@Plugin()',
		'export class PartProvider extends BasePlugin {',
		`  readonly marker = ${JSON.stringify(`part-provider-${version}`)}`,
		'}',
		'class RequiredPart extends PluginPart<PartOwner> {',
		'  constructor(private readonly provider: PartProvider) { super() }',
		'  marker() { return this.provider.marker }',
		'}',
		'@Plugin()',
		'export class PartOwner extends BasePlugin {',
		'  private readonly required = this.parts.use(RequiredPart)',
		"  injected = ''",
		'  protected override init() { this.injected = this.required.marker() }',
		'}',
		`export const runtimePlugins = ${available ? '[ViteStatic, ConfiguredPlugin, PartProvider, PartOwner]' : '[ConfiguredPlugin, PartProvider, PartOwner]'}`,
		'',
	].join('\n')
}
