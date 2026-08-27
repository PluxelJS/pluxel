import { createAdapter } from 'elysia/adapter'
import { WebStandardAdapter } from 'elysia/adapter/web-standard'
import { buildGlobalWSHandler } from 'elysia/ws'
import { setWebSocketHooks } from 'crossws'

export const SrvxCrosswsAdapter = createAdapter({
	...WebStandardAdapter,
	name: 'pluxel-srvx-crossws-spike',
	runtime: 'unknown',
	websocket: true,
})

// `buildGlobalWSHandler()` is intentionally called once. Its callbacks dispatch
// through immutable connection data supplied by each owner app during upgrade.
const elysiaWebSocketHandler = buildGlobalWSHandler()

function unsupported(operation) {
	throw new Error(`${operation} is owned by the host carrier`)
}

function sendStatus(result) {
	// crossws deliberately permits adapters whose send operation has no numeric
	// status. This is one of the semantic gaps documented by the spike.
	return typeof result === 'number' ? result : 0
}

function scopeTopic(ownerToken, topic) {
	return `pluxel:${encodeURIComponent(ownerToken)}:${topic}`
}

function asElysiaSocket(peer, data, ownerToken, cache) {
	const cached = cache.get(peer)
	if (cached) return cached

	let socket
	socket = {
		data,
		send: (value, compress) => sendStatus(peer.send(value, { compress })),
		sendText: (value, compress) => sendStatus(peer.send(value, { compress })),
		sendBinary: (value, compress) => sendStatus(peer.send(value, { compress })),
		close: (code, reason) => peer.close(code, reason),
		terminate: () => peer.terminate(),
		ping: (value) => sendStatus(peer.ping(value)),
		pong: () => unsupported('WebSocket pong'),
		publish: (topic, value, compress) => {
			peer.publish(scopeTopic(ownerToken, topic), value, { compress })
			return 0
		},
		publishText: (topic, value, compress) => {
			peer.publish(scopeTopic(ownerToken, topic), value, { compress })
			return 0
		},
		publishBinary: (topic, value, compress) => {
			peer.publish(scopeTopic(ownerToken, topic), value, { compress })
			return 0
		},
		subscribe: (topic) => peer.subscribe(scopeTopic(ownerToken, topic)),
		unsubscribe: (topic) => peer.unsubscribe(scopeTopic(ownerToken, topic)),
		isSubscribed: (topic) => peer.topics.has(scopeTopic(ownerToken, topic)),
		get subscriptions() {
			const prefix = scopeTopic(ownerToken, '')
			return [...peer.topics]
				.filter((topic) => topic.startsWith(prefix))
				.map((topic) => topic.slice(prefix.length))
		},
		cork: (callback) => callback(socket),
		get remoteAddress() {
			return peer.remoteAddress ?? ''
		},
		get readyState() {
			return peer.websocket.readyState ?? 1
		},
		get binaryType() {
			return peer.websocket.binaryType
		},
		set binaryType(value) {
			peer.websocket.binaryType = value
		},
	}

	cache.set(peer, socket)
	return socket
}

/**
 * Attach the minimum public server surface needed by the executable spike.
 *
 * This is deliberately not production code. In particular, numeric send
 * status, explicit pong, request accounting, runtime metadata, and Elysia's
 * application-level WebSocket tuning still need upstream carrier seams.
 */
export function attachOwnerServerView(app, ownerToken) {
	const peers = new Set()

	const view = {
		id: ownerToken,
		url: new URL('http://pluxel.invalid'),
		port: 0,
		hostname: 'pluxel.invalid',
		development: false,
		get pendingRequests() {
			return 0
		},
		get pendingWebSockets() {
			return peers.size
		},
		fetch: (request) => app.fetch(request, view),
		upgrade(request, options = {}) {
			const data = options.data ?? {}
			const sockets = new WeakMap()

			// Extra connection data is allowed by the public Elysia upgrade contract.
			// The global handler ignores unknown keys and continues to dispatch through
			// the callbacks Elysia placed in this object.
			data.pluxelOwnerToken = ownerToken

			setWebSocketHooks(request, {
				upgrade: () => ({
					headers: options.headers,
					namespace: ownerToken,
					context: { ownerToken },
				}),
				open(peer) {
					peers.add(peer)
					return elysiaWebSocketHandler.open?.(asElysiaSocket(peer, data, ownerToken, sockets))
				},
				message(peer, message) {
					return elysiaWebSocketHandler.message(
						asElysiaSocket(peer, data, ownerToken, sockets),
						message.data,
					)
				},
				drain(peer) {
					return elysiaWebSocketHandler.drain?.(asElysiaSocket(peer, data, ownerToken, sockets))
				},
				close(peer, details) {
					peers.delete(peer)
					return elysiaWebSocketHandler.close?.(
						asElysiaSocket(peer, data, ownerToken, sockets),
						details.code ?? 1000,
						details.reason ?? '',
					)
				},
				error(peer, error) {
					peers.delete(peer)
					console.error(`[${ownerToken}] WebSocket carrier error`, error)
				},
				ping(peer, payload) {
					return elysiaWebSocketHandler.ping?.(
						asElysiaSocket(peer, data, ownerToken, sockets),
						payload,
					)
				},
				pong(peer, payload) {
					return elysiaWebSocketHandler.pong?.(
						asElysiaSocket(peer, data, ownerToken, sockets),
						payload,
					)
				},
			})

			return true
		},
		publish(topic, value, compress) {
			const scoped = scopeTopic(ownerToken, topic)
			for (const peer of peers) if (peer.topics.has(scoped)) peer.send(value, { compress })
			return 0
		},
		requestIP: () => null,
		timeout: () => unsupported('server.timeout()'),
		stop: () => unsupported('server.stop()'),
		reload: () => unsupported('server.reload()'),
		ref: () => unsupported('server.ref()'),
		unref: () => unsupported('server.unref()'),
		[Symbol.dispose]: () => unsupported('server[Symbol.dispose]()'),
	}

	// The WS route currently reads app.server to perform the upgrade, while the
	// Web Standard context receives its server through app.fetch's second arg.
	app.server = view

	return {
		view,
		async drain(code = 1012, reason = 'Service Restart') {
			for (const peer of peers) peer.close(code, reason)
		},
	}
}
