import { createScriptScope } from '@pluxel/agent-sdk/host'
import { createHost } from '@pluxel/host/cloudflare'
import { RequestConsumer } from './consumer'
import { RequestProvider } from './provider'

type Env = {
	BACKEND: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
}

async function load(request: Request, env: Env) {
	await using host = await createHost({
		plugins: [{ plugin: RequestProvider }, { plugin: RequestConsumer, autoStart: true }],
		coreConfig: {
			http: {
				fetch: (input, init) => env.BACKEND.fetch(input, init),
				allowedOrigins: ['https://backend.test'],
				headers: { 'x-fixture': 'managed-fetch' },
				records: 'off',
			},
		},
	})
	await host.start()
	const { summary } = await host.status()
	await using scope = createScriptScope({ ctx: host.ctx, signal: request.signal })
	const { instance } = await scope.sdk.plugin(RequestConsumer.nodeAddress()).instance()
	const id = new URL(request.url).pathname.slice(1)
	if (id === 'cancelled') return await instance.checkCancelledFetch(id)
	return {
		...(await instance.load(id, request.signal)),
		running: summary.running,
		nodeGlobals: typeof process !== 'undefined' || typeof Buffer !== 'undefined',
	}
}

export default {
	async fetch(request: Request, env: Env) {
		return Response.json(await load(request, env))
	},
}
