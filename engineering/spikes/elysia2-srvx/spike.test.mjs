import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { getWebSocketHooks } from 'crossws'
import nodeWebSocketAdapter from 'crossws/adapters/node'
import { plugin as crosswsPlugin } from 'crossws/server/node'
import { Elysia } from 'elysia'
import { createAdapter } from 'elysia/adapter'
import { WebStandardAdapter } from 'elysia/adapter/web-standard'
import { autoHead } from 'elysia/auto-head'
import { websocket } from 'elysia/websocket'
import { serve } from 'srvx/node'

import { attachOwnerServerView, SrvxCrosswsAdapter } from './carrier.mjs'

function websocketMessages(url, outbound, expectedCount = 2) {
	return new Promise((resolve, reject) => {
		const messages = []
		const socket = new WebSocket(url)
		const timeout = setTimeout(
			() => reject(new Error(`WebSocket timeout: ${JSON.stringify(messages)}`)),
			3_000,
		)

		socket.addEventListener('open', () => socket.send(outbound))
		socket.addEventListener('message', (event) => {
			messages.push(String(event.data))
			if (messages.length === expectedCount) socket.close()
		})
		socket.addEventListener('close', () => {
			clearTimeout(timeout)
			resolve(messages)
		})
		socket.addEventListener('error', () => {
			clearTimeout(timeout)
			reject(new Error(`WebSocket handshake failed for ${url}`))
		})
	})
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
}

function close(server) {
	return new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	)
}

function declaredRoutes(app) {
	return app.routes.map(({ method, path }) => ({ method, path }))
}

async function fetchFact(app, method, path) {
	const response = await app.fetch(new Request(`http://local${path}`, { method }))

	return {
		status: response.status,
		text: await response.text(),
		route: response.headers.get('x-route'),
	}
}

function makeOwner(ownerToken) {
	const app = new Elysia({ adapter: SrvxCrosswsAdapter })
		.use(websocket())
		.get(`/${ownerToken}/server`, ({ server }) => server?.id ?? 'no-server')
		.ws(`/${ownerToken}/ws`, {
			upgrade: { 'x-owner': ownerToken },
			open(socket) {
				socket.send(`open:${ownerToken}:${socket.server?.id ?? 'no-server'}`)
			},
			message(socket, message) {
				socket.send(`${ownerToken}:${message}`)
			},
		})

	const attachment = attachOwnerServerView(app, ownerToken)
	app.compile()

	return { app, ...attachment }
}

test('public modules, route inventory, and native compile seal are sufficient', async () => {
	const functionPlugin = (app) => app.get('/function', () => 'function')
	const lazyPlugin = Promise.resolve(new Elysia().get('/lazy/:id', ({ params }) => params.id))
	const app = new Elysia().use(functionPlugin).use(lazyPlugin)

	await app.modules

	assert.deepEqual(
		app.routes.map(({ method, path }) => ({ method, path })),
		[
			{ method: 'GET', path: '/function' },
			{ method: 'GET', path: '/lazy/:id' },
		],
	)

	assert.equal(app.compile(), app)
	assert.equal(await (await app.fetch(new Request('http://local/lazy/42'))).text(), '42')

	for (const mutation of [
		() => app.get('/late', () => 'late'),
		() => app.decorate('late', true),
		() => app.state('late', true),
		() => app.beforeHandle(() => {}),
	])
		assert.throws(mutation, /app was sealed/)
})

test('public custom adapter carries owner server context through fetch and WS inventory', async () => {
	const { app, view } = makeOwner('inventory')

	assert.deepEqual(
		app.routes.map(({ method, path }) => ({ method, path })),
		[
			{ method: 'GET', path: '/inventory/server' },
			{ method: 'WS', path: '/inventory/ws' },
		],
	)

	const withoutFetchServer = await app.fetch(new Request('http://local/inventory/server'))
	assert.equal(await withoutFetchServer.text(), 'no-server')

	const withFetchServer = await app.fetch(new Request('http://local/inventory/server'), view)
	assert.equal(await withFetchServer.text(), 'inventory')
})

test('public inventory keeps declared patterns and omits application-level WS tuning', () => {
	const app = new Elysia({ adapter: SrvxCrosswsAdapter })
		.use(websocket({ idleTimeout: 12, maxPayloadLength: 1_234 }))
		.get('/users/:id', () => 'id')
		.get('/users/:name', () => 'name')
		.ws('/socket', { message() {} })

	assert.deepEqual(
		app.routes.map(({ method, path }) => ({ method, path })),
		[
			{ method: 'GET', path: '/users/:id' },
			{ method: 'GET', path: '/users/:name' },
			{ method: 'WS', path: '/socket' },
		],
	)

	const websocketRoute = app.routes.at(-1)
	assert.equal(websocketRoute.websocket, undefined)
	assert.equal(websocketRoute.hooks.idleTimeout, undefined)
	assert.equal(websocketRoute.hooks.maxPayloadLength, undefined)
})

test('public inventory preserves parameter spelling while compile resolves equivalent matchers by order', async () => {
	for (const { first, second, probes } of [
		{
			first: '/users/:id',
			second: '/users/:name',
			probes: ['/users/42'],
		},
		{
			first: '/optional/:id?',
			second: '/optional/:name?',
			probes: ['/optional', '/optional/', '/optional/42'],
		},
	]) {
		for (const [earlier, later] of [
			[first, second],
			[second, first],
		]) {
			const app = new Elysia().get(earlier, () => earlier).get(later, () => later)

			assert.deepEqual(declaredRoutes(app), [
				{ method: 'GET', path: earlier },
				{ method: 'GET', path: later },
			])
			assert.deepEqual(app.history, [
				{ sequence: 0, method: 'GET', path: earlier },
				{ sequence: 1, method: 'GET', path: later },
			])
			assert.equal(app.compile(), app)

			for (const path of probes) assert.equal((await fetchFact(app, 'GET', path)).text, later)
		}
	}
})

test('public inventory exposes generated methods but omits strict-path matcher semantics', async () => {
	const route = (app) =>
		app.get('/single', ({ set }) => {
			set.headers['x-route'] = 'get'
			return 'get'
		})
	const loose = route(new Elysia())
	const strict = route(new Elysia({ strictPath: true }))
	const withAutoHead = route(new Elysia().use(autoHead()))

	await withAutoHead.modules

	for (const app of [loose, strict]) {
		assert.deepEqual(declaredRoutes(app), [{ method: 'GET', path: '/single' }])
		assert.deepEqual(app.history, [{ sequence: 0, method: 'GET', path: '/single' }])
	}
	assert.deepEqual(declaredRoutes(withAutoHead), [
		{ method: 'GET', path: '/single' },
		{ method: 'HEAD', path: '/single' },
	])
	assert.deepEqual(withAutoHead.history, [
		{ sequence: 0, method: 'GET', path: '/single' },
		{ sequence: 1, method: 'HEAD', path: '/single' },
	])

	for (const app of [loose, strict, withAutoHead]) app.compile()

	assert.deepEqual(await fetchFact(loose, 'GET', '/single/'), {
		status: 200,
		text: 'get',
		route: 'get',
	})
	assert.equal((await fetchFact(strict, 'GET', '/single/')).status, 404)
	assert.equal((await fetchFact(loose, 'HEAD', '/single')).status, 404)
	assert.deepEqual(await fetchFact(withAutoHead, 'HEAD', '/single'), {
		status: 200,
		text: '',
		route: 'get',
	})

	// URLPattern only answers individual witness queries. The declaration below
	// disagrees with Elysia's default loose trailing-slash behavior, and Node has
	// no public language-equivalence comparator that could repair this generally.
	const urlPattern = new URLPattern({ pathname: '/single' })
	assert.equal(urlPattern.test({ pathname: '/single' }), true)
	assert.equal(urlPattern.test({ pathname: '/single/' }), false)
	assert.equal(typeof URLPattern.compareComponent, 'undefined')
})

test('parameter, optional, static, and wildcard overlap follows Elysia precedence', async () => {
	for (const reverse of [false, true]) {
		const app = new Elysia()
		const routes = [
			['/items/:id?', 'optional'],
			['/items', 'static'],
			['/files/*', 'wildcard'],
			['/files/:id', 'parameter'],
		]
		if (reverse) routes.reverse()
		for (const [path, result] of routes) app.get(path, () => result)

		app.compile()

		assert.equal((await fetchFact(app, 'GET', '/items')).text, 'static')
		assert.equal((await fetchFact(app, 'GET', '/items/42')).text, 'optional')
		assert.equal((await fetchFact(app, 'GET', '/files/name')).text, 'parameter')
		assert.equal((await fetchFact(app, 'GET', '/files/a/b')).text, 'wildcard')
	}
})

test('ALL inventory uses a wildcard method while concrete methods keep precedence', async () => {
	for (const concreteFirst of [false, true]) {
		const app = new Elysia()
		const registerAll = () =>
			app.all('/method', ({ set }) => {
				set.headers['x-route'] = 'all'
				return 'all'
			})
		const registerGet = () =>
			app.get('/method', ({ set }) => {
				set.headers['x-route'] = 'get'
				return 'get'
			})

		if (concreteFirst) {
			registerGet()
			registerAll()
		} else {
			registerAll()
			registerGet()
		}

		assert.deepEqual(
			declaredRoutes(app).map(({ method }) => method),
			concreteFirst ? ['GET', '*'] : ['*', 'GET'],
		)
		app.compile()

		assert.equal((await fetchFact(app, 'GET', '/method')).route, 'get')
		assert.equal((await fetchFact(app, 'POST', '/method')).route, 'all')
		assert.equal((await fetchFact(app, 'HEAD', '/method')).route, 'all')
	}
})

test('srvx Node plus crossws serves two sealed owners through one Elysia global handler', async (t) => {
	const ownerA = makeOwner('a')
	const ownerB = makeOwner('b')
	const owners = new Map([
		['a', ownerA],
		['b', ownerB],
	])

	const carrier = serve({
		hostname: '127.0.0.1',
		port: 0,
		silent: true,
		gracefulShutdown: false,
		plugins: [crosswsPlugin({})],
		async fetch(request) {
			const ownerToken = new URL(request.url).pathname.split('/')[1]
			const owner = owners.get(ownerToken)
			if (!owner) return new Response('Not Found', { status: 404 })

			return (await owner.app.fetch(request, owner.view)) ?? new Response(null, { status: 204 })
		},
	})

	t.after(async () => carrier.close(true))
	await carrier.ready()

	assert.equal(carrier.runtime, 'node')
	assert.equal(typeof carrier.node?.handler, 'function')
	assert.ok(carrier.node?.server)
	assert.equal(carrier.node.server.listenerCount('upgrade'), 1)

	assert.equal(await (await fetch(new URL('/a/server', carrier.url))).text(), 'a')
	assert.equal(await (await fetch(new URL('/b/server', carrier.url))).text(), 'b')

	const websocketBase = carrier.url.replace(/^http/, 'ws')
	const [messagesA, messagesB] = await Promise.all([
		websocketMessages(new URL('/a/ws', websocketBase), 'ping-a'),
		websocketMessages(new URL('/b/ws', websocketBase), 'ping-b'),
	])

	assert.deepEqual(messagesA, ['open:a:a', 'a:ping-a'])
	assert.deepEqual(messagesB, ['open:b:b', 'b:ping-b'])
})

test('srvx Node handler can share one host listener with path-arbitrated upgrades', async (t) => {
	const carrier = serve({
		manual: true,
		silent: true,
		gracefulShutdown: false,
		fetch: () => new Response('srvx-http'),
	})
	const owner = makeOwner('business')
	const businessWebSocket = nodeWebSocketAdapter({
		async resolve(request) {
			await owner.app.fetch(request, owner.view)
			return getWebSocketHooks(request) ?? {}
		},
	})
	const hmrWebSocket = nodeWebSocketAdapter({
		hooks: {
			open(peer) {
				peer.send('vite-hmr')
			},
		},
	})
	const host = http.createServer(carrier.node.handler)

	host.on('upgrade', (request, socket, head) => {
		if (request.url === '/@vite-hmr') {
			void hmrWebSocket.handleUpgrade(request, socket, head)
			return
		}

		if (request.url === '/business/ws') {
			void businessWebSocket.handleUpgrade(request, socket, head)
			return
		}

		socket.destroy()
	})

	t.after(async () => {
		await businessWebSocket.close()
		await hmrWebSocket.close()
		await close(host)
		await carrier.close(true)
	})

	await listen(host)
	const address = host.address()
	assert.ok(address && typeof address !== 'string')
	const httpBase = `http://127.0.0.1:${address.port}`
	const websocketBase = `ws://127.0.0.1:${address.port}`

	assert.equal(await (await fetch(httpBase)).text(), 'srvx-http')
	assert.deepEqual(await websocketMessages(`${websocketBase}/@vite-hmr`, 'ignored', 1), [
		'vite-hmr',
	])
	assert.deepEqual(await websocketMessages(`${websocketBase}/business/ws`, 'ping'), [
		'open:business:business',
		'business:ping',
	])
})

test('public virtual listen/stop cannot provide a safe external lifecycle epoch', async () => {
	const events = []
	let virtualServer
	const adapter = createAdapter({
		...WebStandardAdapter,
		name: 'virtual-lifecycle-probe',
		runtime: 'node',
		setup(app) {
			events.push('adapter:setup')
			return app
		},
		listen(app, _options, callback) {
			events.push('adapter:listen')
			virtualServer = {
				stop() {
					events.push('server:stop')
					throw new Error('physical stop is forbidden')
				},
			}
			app.server = virtualServer
			callback?.(virtualServer)
		},
	})
	const app = new Elysia({ adapter })
		.setup(() => events.push('lifecycle:setup'))
		.cleanup(() => events.push('lifecycle:cleanup'))
		.get('/', () => 'ok')

	assert.deepEqual(events, ['adapter:setup'])
	app.listen(0)
	await new Promise((resolve) => setImmediate(resolve))

	// The custom adapter is invoked, but Elysia exposes no public runner for the
	// registered setup epoch.
	assert.deepEqual(events, ['adapter:setup', 'adapter:listen'])
	assert.equal(app.server, virtualServer)

	// A fail-fast physical stop still runs cleanup and clears app.server. Author
	// app.stop() therefore cannot be made harmless through the Server view.
	await assert.rejects(app.stop(), /physical stop is forbidden/)
	assert.deepEqual(events, ['adapter:setup', 'adapter:listen', 'server:stop', 'lifecycle:cleanup'])
	assert.equal(app.server, undefined)
})
