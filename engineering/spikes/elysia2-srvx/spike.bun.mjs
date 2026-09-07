import { plugin as crosswsPlugin } from 'crossws/server/bun'
import { Elysia } from 'elysia'
import { websocket } from 'elysia/websocket'
import { serve } from 'srvx/bun'

import { attachOwnerServerView, SrvxCrosswsAdapter } from './carrier.mjs'

const app = new Elysia({ adapter: SrvxCrosswsAdapter })
	.use(websocket())
	.get('/runtime', ({ server }) => `bun:${server?.id}`)
	.ws('/events', {
		open(socket) {
			socket.send(`open:${socket.server?.id}`)
		},
		message(socket, message) {
			socket.send(`echo:${message}`)
		},
	})
const { view } = attachOwnerServerView(app, 'bun-owner')
app.compile()

const carrier = serve({
	hostname: '127.0.0.1',
	port: 0,
	silent: true,
	gracefulShutdown: false,
	plugins: [crosswsPlugin({})],
	async fetch(request) {
		return (await app.fetch(request, view)) ?? new Response(null, { status: 204 })
	},
})

try {
	await carrier.ready()
	const runtime = await (await fetch(new URL('/runtime', carrier.url))).text()
	if (runtime !== 'bun:bun-owner') throw new Error(`Unexpected HTTP result: ${runtime}`)

	const messages = await new Promise((resolve, reject) => {
		const received = []
		const socket = new WebSocket(new URL('/events', carrier.url.replace(/^http/, 'ws')))
		const timeout = setTimeout(() => reject(new Error('Bun WebSocket timeout')), 3_000)

		socket.addEventListener('open', () => socket.send('bun'))
		socket.addEventListener('message', (event) => {
			received.push(String(event.data))
			if (received.length === 2) socket.close()
		})
		socket.addEventListener('close', () => {
			clearTimeout(timeout)
			resolve(received)
		})
		socket.addEventListener('error', () => reject(new Error('Bun WebSocket failed')))
	})

	const expected = JSON.stringify(['open:bun-owner', 'echo:bun'])
	if (JSON.stringify(messages) !== expected)
		throw new Error(`Unexpected WebSocket result: ${JSON.stringify(messages)}`)

	console.log('Bun srvx/crossws/Elysia owner carrier: PASS')
} finally {
	await carrier.close(true)
}
