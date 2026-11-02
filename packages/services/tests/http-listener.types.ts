import type { ListenElysiaOptions } from '../src/elysia-node'

const nativeOptions = {
	port: '3000',
	publicOrigin: 'https://app.example.test',
	node: { keepAliveTimeout: 1000 },
	trustProxy: 'loopback',
	plugins: [(server) => server.options.middleware.push((_request, next) => next())],
	error: () => new Response('handled'),
} satisfies ListenElysiaOptions

const customDispatch = {
	// @ts-expect-error The managed listener supplies its own Host dispatch.
	fetch: () => new Response(),
} satisfies ListenElysiaOptions

const ipcTransport = {
	// @ts-expect-error The TCP convenience listener cannot report an IPC address.
	node: { path: '/tmp/host.sock' },
} satisfies ListenElysiaOptions

void [nativeOptions, customDispatch, ipcTransport]
