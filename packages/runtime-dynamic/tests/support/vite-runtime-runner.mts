import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { formatPluginNodeReference } from '@pluxel/core'
import { requireRuntimeHttpService } from '@pluxel/runtime/internal'
import { createServer } from 'vite'

import { requireLoaderService } from '../../src/context-plan.ts'
import type { BootedLoaderHmrHost } from '../../src/hmr/host.ts'
import { dynamicRuntimeVitePlugin } from '../../src/vite.ts'

const root = requiredEnv('PLUXEL_DYNAMIC_VITE_ROOT')
const configPath = requiredEnv('PLUXEL_DYNAMIC_VITE_CONFIG')
const pluginPath = requiredEnv('PLUXEL_DYNAMIC_VITE_PLUGIN')
const cacheDir = requiredEnv('PLUXEL_DYNAMIC_VITE_CACHE')

await writeFile(pluginPath, pluginSource('v1'))

const server = await createServer({
	configFile: false,
	root,
	cacheDir,
	logLevel: 'silent',
	optimizeDeps: { noDiscovery: true, include: [] },
	plugins: dynamicRuntimeVitePlugin({ config: configPath }),
	server: {
		host: '127.0.0.1',
		strictPort: false,
		watch: { usePolling: true, interval: 20 },
	},
})

await server.listen()

const controller = (server as unknown as Record<PropertyKey, { booted?: BootedLoaderHmrHost }>)[
	Symbol.for('pluxel.dynamicRuntimeController')
]
assert.ok(controller?.booted, 'dynamic runtime controller is missing')
const ctx = controller.booted.ctx
const loader = requireLoaderService(ctx)
const hmr = controller.booted.hmr
const catalogEntry = loader.api.registry
	.listRegistered()
	.find((candidate) => candidate.rootExportName === 'DynamicHttpPlugin')
assert.ok(catalogEntry, 'DynamicHttpPlugin is absent from the startup catalog')
const address = catalogEntry.address
const addressReference = formatPluginNodeReference(address)
const listenerAddress = server.httpServer?.address()
assert.ok(listenerAddress && typeof listenerAddress !== 'string')
const runtimeUrl = `http://127.0.0.1:${listenerAddress.port}`
const socketUrl = `${runtimeUrl.replace(/^http/, 'ws')}/dynamic/socket`
const sockets: WebSocket[] = []

try {
	await loader.api.control.enable(address)
	assert.equal(loader.api.runtime.isRunning(address), true)
	assert.equal(await readVersion(runtimeUrl), 'v1')
	const v1Socket = await openWebSocket(socketUrl)
	sockets.push(v1Socket.socket)
	assert.equal(await v1Socket.nextMessage(), 'v1')
	const v1SocketClosed = v1Socket.closed

	const replacementBatch = hmr.api.waitForBatch({ timeoutMs: 15_000 })
	await writeFile(pluginPath, pluginSource('v2'))
	const replacement = await replacementBatch
	assert.equal(replacement.ok, true, JSON.stringify(replacement, null, 2))
	assert.equal(
		replacement.pluginChanges?.replaced.some(
			(change) => change.from === addressReference && change.to === addressReference,
		),
		true,
	)
	assert.equal(await readVersion(runtimeUrl), 'v2')
	assert.deepEqual(await v1SocketClosed, { code: 1012, reason: 'Service Restart' })
	const v2Socket = await openWebSocket(socketUrl)
	sockets.push(v2Socket.socket)
	assert.equal(await v2Socket.nextMessage(), 'v2')
	const v2SocketClosed = v2Socket.closed

	const invalidBatch = hmr.api.waitForBatch({
		afterEpoch: replacement.epoch,
		timeoutMs: 15_000,
	})
	await writeFile(pluginPath, 'export const invalidReplacement =')
	const invalid = await invalidBatch
	assert.equal(invalid.ok, false)
	assert.ok(invalid.executeError)
	assert.equal(await readVersion(runtimeUrl), 'v2')
	assert.equal(v2Socket.socket.readyState, WebSocket.OPEN)
	v2Socket.socket.send('rollback-retained')
	assert.equal(await v2Socket.nextMessage(), 'v2:rollback-retained')
	const rollbackSocket = await openWebSocket(socketUrl)
	sockets.push(rollbackSocket.socket)
	assert.equal(await rollbackSocket.nextMessage(), 'v2')
	const rollbackSocketClosed = rollbackSocket.closed

	const removalBatch = hmr.api.waitForBatch({
		afterEpoch: invalid.epoch,
		timeoutMs: 15_000,
	})
	await rm(pluginPath)
	const removal = await removalBatch
	assert.equal(removal.ok, true, JSON.stringify(removal, null, 2))
	assert.ok(removal.pluginChanges?.removed.includes(addressReference))
	assert.equal(loader.api.registry.getCtor(address), undefined)
	assert.equal(loader.api.runtime.isRunning(address), false)
	const removedResponse = await fetch(`${runtimeUrl}/dynamic/version`)
	assert.equal(removedResponse.status, 404)
	assert.equal(
		requireRuntimeHttpService(ctx).matchesWebSocketRoute(upgradeRequest(runtimeUrl)),
		false,
	)
	assert.deepEqual(await v2SocketClosed, { code: 1012, reason: 'Service Restart' })
	assert.deepEqual(await rollbackSocketClosed, { code: 1012, reason: 'Service Restart' })

	const restoredBatch = hmr.api.waitForBatch({
		afterEpoch: removal.epoch,
		timeoutMs: 15_000,
	})
	await writeFile(pluginPath, pluginSource('v3'))
	const restored = await restoredBatch
	assert.equal(restored.ok, true, JSON.stringify(restored, null, 2))
	assert.ok(restored.pluginChanges?.added.includes(addressReference))
	assert.equal(loader.api.runtime.isRunning(address), true)
	assert.equal(await readVersion(runtimeUrl), 'v3')
	assert.equal(
		requireRuntimeHttpService(ctx).matchesWebSocketRoute(upgradeRequest(runtimeUrl)),
		true,
	)
	const v3Socket = await openWebSocket(socketUrl)
	sockets.push(v3Socket.socket)
	assert.equal(await v3Socket.nextMessage(), 'v3')
	v3Socket.socket.close(1000, 'test complete')
	assert.deepEqual(await v3Socket.closed, { code: 1000, reason: 'test complete' })
} finally {
	for (const socket of sockets) {
		if (socket.readyState === WebSocket.OPEN) socket.close()
	}
	await server.close()
}

function requiredEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`missing ${name}`)
	return value
}

function upgradeRequest(baseUrl: string): Request {
	return new Request(`${baseUrl}/dynamic/socket`, {
		headers: { connection: 'Upgrade', upgrade: 'websocket' },
	})
}

async function readVersion(baseUrl: string): Promise<string> {
	const response = await fetch(`${baseUrl}/dynamic/version`)
	assert.equal(response.status, 200)
	return response.text()
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

function pluginSource(version: string): string {
	return [
		"import { BasePlugin, Plugin } from '@pluxel/runtime'",
		"import { websocket } from 'elysia/websocket'",
		"@Plugin({ displayName: 'Dynamic HTTP' })",
		'export class DynamicHttpPlugin extends BasePlugin {',
		`  readonly version = ${JSON.stringify(version)}`,
		`  protected override init() { this.ctx.elysia.use(websocket()).get('/dynamic/version', () => ${JSON.stringify(version)}).ws('/dynamic/socket', { open(socket) { socket.send(${JSON.stringify(version)}) }, message(socket, message) { socket.send(${JSON.stringify(`${version}:`)} + String(message)) } }) }`,
		'}',
		'',
	].join('\n')
}
