import assert from 'node:assert/strict'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import {
	formatPluginNodeReference,
	pluginNodeAddressEqual,
	type PluginConstructor,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	readRuntimePluginStatusOverview,
	requireRuntimeHttpService,
} from '@pluxel/runtime/internal'
import type { StaticRuntimeHost } from '@pluxel/runtime-static'
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { createServer, normalizePath, type HmrContext, type Plugin as VitePlugin } from 'vite'

const root = requiredEnv('PLUXEL_VITE_SMOKE_ROOT')
const entryPath = requiredEnv('PLUXEL_VITE_SMOKE_ENTRY')
const pluginPath = requiredEnv('PLUXEL_VITE_SMOKE_PLUGIN')
const builtPluginPath = requiredEnv('PLUXEL_VITE_SMOKE_BUILT_PLUGIN')
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
	server: {
		host: '127.0.0.1',
		strictPort: false,
		perEnvironmentWatchChangeDuringDev: true,
	},
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
const partProviderAddress = capturedHost
	.describeCatalog()
	.plugins.find((plugin) => plugin.address.definition.exportName === 'PartProvider')?.address
assert.ok(partProviderAddress, 'Part provider is absent from the startup catalog')
const builtAddress = capturedHost
	.describeCatalog()
	.plugins.find((plugin) => plugin.address.definition.exportName === 'BuiltStatic')?.address
assert.ok(builtAddress, 'built Plugin is absent from the startup catalog')
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
	const startupStatusesOverview = await readRuntimePluginStatusOverview(capturedHost.ctx)
	const startupStatuses = startupStatusesOverview.statuses
	const startupSourceStatus = startupStatuses.find((status) =>
		pluginNodeAddressEqual(status.address, address),
	)
	const startupBuiltStatus = startupStatuses.find((status) =>
		pluginNodeAddressEqual(status.address, builtAddress),
	)
	assert.deepEqual(startupSourceStatus?.execution, {
		kind: 'static-catalog',
		artifact: { kind: 'source-module' },
		update: { kind: 'catalog-hmr' },
	})
	assert.equal(startupSourceStatus?.recentUpdate, null)
	assert.deepEqual(startupBuiltStatus?.execution, {
		kind: 'static-catalog',
		artifact: { kind: 'built-module' },
		update: { kind: 'catalog-hmr' },
	})
	assert.equal(JSON.stringify(startupSourceStatus?.execution).includes(root), false)
	assert.equal(JSON.stringify(startupBuiltStatus?.execution).includes(root), false)

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
		['BuiltStatic', 'ConfiguredPlugin', 'PartOwner', 'PartProvider', 'ViteStatic'],
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
	const appliedStatusOverview = await readRuntimePluginStatusOverview(capturedHost.ctx)
	const appliedStatus = appliedStatusOverview.statuses.find((status) =>
		pluginNodeAddressEqual(status.address, address),
	)
	assert.equal(appliedStatus?.execution.artifact.kind, 'source-module')
	assert.equal(appliedStatus?.execution.update.kind, 'catalog-hmr')
	assert.equal(appliedStatus?.recentUpdate?.batch.outcome, 'applied')
	assert.equal(appliedStatus?.recentUpdate?.batch.phase, null)
	assert.ok((appliedStatus?.recentUpdate?.batch.sequence ?? 0) > 0)
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
	const replacementSocketClosed = replacementSocket.closed
	const originalBuiltPlugin = await readFile(builtPluginPath, 'utf8')
	await writeFile(builtPluginPath, 'export const invalidBuiltPlugin =')
	await assert.rejects(() => invokeHotUpdate(routePlugin, builtPluginPath))
	const statusesAfterBuiltFailureOverview = await readRuntimePluginStatusOverview(capturedHost.ctx)
	const statusesAfterBuiltFailure = statusesAfterBuiltFailureOverview.statuses
	const retainedBuiltStatus = statusesAfterBuiltFailure.find((status) =>
		pluginNodeAddressEqual(status.address, builtAddress),
	)
	assert.equal(retainedBuiltStatus?.recentUpdate?.batch.outcome, 'retained-previous')
	assert.equal(retainedBuiltStatus?.recentUpdate?.batch.phase, 'evaluate')
	assert.equal(retainedBuiltStatus?.execution.artifact.kind, 'built-module')
	assert.equal(retainedBuiltStatus?.execution.update.kind, 'catalog-hmr')
	assert.ok(
		(retainedBuiltStatus?.recentUpdate?.batch.sequence ?? 0) >
			(appliedStatus?.recentUpdate?.batch.sequence ?? 0),
	)
	await writeFile(builtPluginPath, originalBuiltPlugin)

	await writeFile(pluginPath, 'export const invalidReplacement =')
	await assert.rejects(() => invokeHotUpdate(routePlugin, pluginPath))
	const retainedStatusOverview = await readRuntimePluginStatusOverview(capturedHost.ctx)
	const retainedStatus = retainedStatusOverview.statuses.find((status) =>
		pluginNodeAddressEqual(status.address, address),
	)
	assert.equal(retainedStatus?.recentUpdate?.batch.outcome, 'retained-previous')
	assert.equal(retainedStatus?.recentUpdate?.batch.phase, 'evaluate')
	assert.ok(
		(retainedStatus?.recentUpdate?.batch.sequence ?? 0) >
			(appliedStatus?.recentUpdate?.batch.sequence ?? 0),
	)
	const lastKnownGoodResponse = await fetch(`${runtimeUrl}/configured/version`)
	assert.equal(await lastKnownGoodResponse.text(), 'v2')
	assert.equal(replacementSocket.socket.readyState, WebSocket.OPEN)
	const lastKnownGoodSocket = await openWebSocket(
		`${runtimeUrl.replace(/^http/, 'ws')}/configured/socket`,
	)
	sockets.push(lastKnownGoodSocket.socket)
	assert.equal(await lastKnownGoodSocket.nextMessage(), 'v2')
	lastKnownGoodSocket.socket.close()
	await lastKnownGoodSocket.closed
	replacementSocket.socket.close()
	await replacementSocketClosed

	// A valid source edit after evaluation failure must activate without a Start command.
	await writeFile(pluginPath, pluginSource('syntax-fixed', true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.equal(pluginService.isRunning(address), true)
	assert.equal(
		await fetch(`${runtimeUrl}/configured/version`).then((response) => response.text()),
		'syntax-fixed',
	)

	// Init failure happens after the old dependency closure has stopped. Healthy siblings run,
	// and a later source edit must recover both provider and required consumer automatically.
	await writeFile(pluginPath, pluginSource('init-broken', true, true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.equal(pluginService.isRunning(partProviderAddress), false)
	assert.equal(pluginService.isRunning(partOwnerAddress), false)
	assert.equal(pluginService.isRunning(configuredAddress), true)
	const failedOverview = await readRuntimePluginStatusOverview(capturedHost.ctx)
	const failedProvider = failedOverview.statuses.find((status) =>
		pluginNodeAddressEqual(status.address, partProviderAddress),
	)
	const blockedConsumer = failedOverview.statuses.find((status) =>
		pluginNodeAddressEqual(status.address, partOwnerAddress),
	)
	assert.equal(failedProvider?.recentUpdate?.batch.outcome, 'applied-with-issues')
	assert.equal(failedProvider?.recentUpdate?.batch.phase, 'lifecycle')
	assert.ok(
		failedProvider?.recentUpdate?.lifecycle?.issues.some((issue) => issue.kind === 'start-failed'),
	)
	assert.ok(
		blockedConsumer?.recentUpdate?.lifecycle?.issues.some(
			(issue) =>
				issue.kind === 'dependency-blocked' &&
				issue.blockedBy === formatPluginNodeReference(partProviderAddress),
		),
	)
	assert.equal(
		await fetch(`${runtimeUrl}/configured/version`).then((response) => response.text()),
		'init-broken',
	)
	await writeFile(pluginPath, pluginSource('v2', true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.equal(pluginService.isRunning(partProviderAddress), true)
	assert.equal(pluginService.isRunning(partOwnerAddress), true)
	assert.equal(
		Reflect.get(pluginService.getInstance(partOwnerAddress) ?? {}, 'injected'),
		'part-provider-v2',
	)
	const recoveredOverview = await readRuntimePluginStatusOverview(capturedHost.ctx)
	for (const recoveredAddress of [partProviderAddress, partOwnerAddress]) {
		const recoveredStatus = recoveredOverview.statuses.find((status) =>
			pluginNodeAddressEqual(status.address, recoveredAddress),
		)
		assert.equal(recoveredStatus?.recentUpdate?.batch.outcome, 'applied')
		assert.deepEqual(recoveredStatus?.recentUpdate?.lifecycle, { issues: [] })
	}

	assert.equal(
		await fetch(`${runtimeUrl}/vite-static/version`).then((response) => response.text()),
		'v2',
	)
	const removableSocket = await openWebSocket(
		`${runtimeUrl.replace(/^http/, 'ws')}/vite-static/socket`,
	)
	sockets.push(removableSocket.socket)
	assert.equal(await removableSocket.nextMessage(), 'v2')
	const removableSocketClosed = removableSocket.closed

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
	const removedResponse = await fetch(`${runtimeUrl}/vite-static/version`)
	assert.equal(removedResponse.status, 404)
	assert.equal(
		requireRuntimeHttpService(capturedHost.ctx).matchesWebSocketRoute(
			new Request(`${runtimeUrl}/vite-static/socket`, {
				headers: { connection: 'Upgrade', upgrade: 'websocket' },
			}),
		),
		false,
	)
	assert.deepEqual(await removableSocketClosed, { code: 1012, reason: 'Service Restart' })

	await writeFile(pluginPath, pluginSource('v3', true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.equal(pluginService.isRunning(address), true)
	assert.equal(
		await fetch(`${runtimeUrl}/vite-static/version`).then((response) => response.text()),
		'v3',
	)
	const restoredSocket = await openWebSocket(
		`${runtimeUrl.replace(/^http/, 'ws')}/vite-static/socket`,
	)
	sockets.push(restoredSocket.socket)
	assert.equal(await restoredSocket.nextMessage(), 'v3')
	restoredSocket.socket.close()
	await restoredSocket.closed

	const beforeReplacementStatusesOverview = await readRuntimePluginStatusOverview(capturedHost.ctx)
	const beforeReplacementStatuses = beforeReplacementStatusesOverview.statuses
	const beforeReplacementSource = beforeReplacementStatuses.find((status) =>
		pluginNodeAddressEqual(status.address, address),
	)?.execution
	const beforeReplacementBuilt = beforeReplacementStatuses.find((status) =>
		pluginNodeAddressEqual(status.address, builtAddress),
	)?.execution
	const originalEntry = await readFile(entryPath, 'utf8')
	const failingEntry = originalEntry.replace(
		'  configure() {',
		"  configure() { throw new Error('replacement configure failed')",
	)
	assert.notEqual(failingEntry, originalEntry)
	await writeFile(entryPath, failingEntry)
	await assert.rejects(
		() => invokeHotUpdate(routePlugin, entryPath),
		/replacement configure failed/,
	)
	const compensatedHost = host
	assert.ok(compensatedHost, 'previous application was not restored after replacement failure')
	assert.notEqual(compensatedHost, capturedHost)
	const compensatedStatusesOverview = await readRuntimePluginStatusOverview(compensatedHost.ctx)
	const compensatedStatuses = compensatedStatusesOverview.statuses
	const compensatedSource = compensatedStatuses.find((status) =>
		pluginNodeAddressEqual(status.address, address),
	)
	const compensatedBuilt = compensatedStatuses.find((status) =>
		pluginNodeAddressEqual(status.address, builtAddress),
	)
	assert.deepEqual(compensatedSource?.execution, beforeReplacementSource)
	assert.deepEqual(compensatedBuilt?.execution, beforeReplacementBuilt)
	assert.equal(compensatedSource?.recentUpdate?.batch.outcome, 'restored-previous')
	assert.equal(compensatedSource?.recentUpdate?.batch.phase, 'application-reload')
	assert.equal(compensatedBuilt?.recentUpdate?.batch.outcome, 'restored-previous')
	assert.equal(
		await fetch(`${runtimeUrl}/vite-static/version`).then((response) => response.text()),
		'v3',
	)

	await writeFile(entryPath, originalEntry)
	await invokeHotUpdate(routePlugin, entryPath)
	const replacementHost = host
	assert.ok(replacementHost, 'valid application did not replace the compensated host')
	assert.notEqual(replacementHost, compensatedHost)
	const finalStatusOverview = await readRuntimePluginStatusOverview(replacementHost.ctx)
	const finalStatus = finalStatusOverview.statuses.find((status) =>
		pluginNodeAddressEqual(status.address, address),
	)
	assert.equal(finalStatus?.recentUpdate?.batch.outcome, 'applied')
	assert.equal(
		await fetch(`${runtimeUrl}/vite-static/version`).then((response) => response.text()),
		'v3',
	)

	await writeFile(pluginPath, pluginSource('v4', true))
	await Promise.all([
		invokeHotUpdate(routePlugin, pluginPath),
		invokeHotUpdate(routePlugin, pluginPath),
	])
	const serializedHost = host
	assert.ok(serializedHost, 'serialized source updates lost the active host')
	assert.equal(serializedHost, replacementHost)
	const serializedStatusOverview = await readRuntimePluginStatusOverview(serializedHost.ctx)
	const serializedStatus = serializedStatusOverview.statuses.find((status) =>
		pluginNodeAddressEqual(status.address, address),
	)
	assert.equal(serializedStatus?.recentUpdate?.batch.outcome, 'applied')
	assert.ok(
		(serializedStatus?.recentUpdate?.batch.sequence ?? 0) >=
			(finalStatus?.recentUpdate?.batch.sequence ?? 0) + 2,
	)
	assert.equal(
		await fetch(`${runtimeUrl}/vite-static/version`).then((response) => response.text()),
		'v4',
	)

	const originalSourcePlugin = await readFile(pluginPath, 'utf8')
	const catalogBeforeUnlink = serializedHost.describeCatalog().plugins
	try {
		await unlink(pluginPath)
		await invokeViteWatchChange(pluginPath, 'delete')
		await assert.rejects(() => invokeHotUpdate(routePlugin, pluginPath))
		assert.equal(host, serializedHost)

		const statusesAfterUnlinkOverview = await readRuntimePluginStatusOverview(serializedHost.ctx)
		const statusesAfterUnlink = statusesAfterUnlinkOverview.statuses
		const unlinkSequences = new Set<number>()
		for (const catalogPlugin of catalogBeforeUnlink) {
			const status = statusesAfterUnlink.find((candidate) =>
				pluginNodeAddressEqual(candidate.address, catalogPlugin.address),
			)
			const recentUpdate = status?.recentUpdate
			assert.ok(
				recentUpdate,
				`${catalogPlugin.definition.exportName} has no static unlink update attribution`,
			)
			assert.equal(recentUpdate.batch.outcome, 'retained-previous')
			assert.equal(recentUpdate.batch.phase, 'evaluate')
			unlinkSequences.add(recentUpdate.batch.sequence)
		}
		assert.equal(unlinkSequences.size, 1)
		const unlinkSequence = unlinkSequences.values().next().value
		assert.ok(
			(unlinkSequence ?? 0) > (serializedStatus?.recentUpdate?.batch.sequence ?? 0),
			'static unlink did not record one newer catalog-wide update',
		)
	} finally {
		await writeFile(pluginPath, originalSourcePlugin)
	}
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

async function invokeViteWatchChange(
	changedFile: string,
	event: 'create' | 'update' | 'delete',
): Promise<void> {
	await server.environments.ssr.pluginContainer.watchChange(normalizePath(changedFile), { event })
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

function pluginSource(version: string, available: boolean, failProvider = false): string {
	return [
		"import { BasePlugin, Plugin, PluginPart, v } from '@pluxel/runtime'",
		"import { websocket } from 'elysia/websocket'",
		"import { BuiltStatic } from '@fixture/vite-built'",
		"export const ViteStaticConfig = v.object({ label: v.optional(v.string(), 'default') })",
		"@Plugin({ displayName: 'Vite static', forkable: true })",
		'export class ViteStatic extends BasePlugin {',
		'  private readonly settings = this.configs.use(ViteStaticConfig)',
		`  readonly version = ${JSON.stringify(version)}`,
		"  configuredLabel = ''",
		`  protected override init() { this.configuredLabel = this.settings.label; if (this.ctx.pluginInfo.nodeAddress.variant === 'default') this.ctx.elysia.use(websocket()).get('/vite-static/version', () => ${JSON.stringify(version)}).ws('/vite-static/socket', { open(socket) { socket.send(${JSON.stringify(version)}) } }) }`,
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
		...(failProvider
			? ["  protected override init() { throw new Error('provider init failed') }"]
			: []),
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
		`export const runtimePlugins = ${available ? '[ViteStatic, ConfiguredPlugin, PartProvider, PartOwner, BuiltStatic]' : '[ConfiguredPlugin, PartProvider, PartOwner, BuiltStatic]'}`,
		'',
	].join('\n')
}
