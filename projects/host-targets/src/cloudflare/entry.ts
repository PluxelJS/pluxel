import { WorkerEntrypoint, exports as workerExports } from 'cloudflare:workers'
import { createWorkerHost } from '@pluxel/host/cloudflare'
import { closeOnHotReload } from '@pluxel/host-vite/hmr'
import { demoConfig } from '../demo-config'
import { assertDemoUpdate, readDemo } from '../demo'
import * as plugins from '@pluxel-example/host-targets-plugins'
import { demoApplication } from '../demo-plugins'
import { demoUpdateEvent, type DemoUpdate } from '../protocol'

declare global {
	namespace Cloudflare {
		interface GlobalProps {
			mainModule: typeof import('./entry')
		}
	}
}

export class GreetingSource extends WorkerEntrypoint {
	fetch() {
		return Response.json({ source: 'workerd Service Binding' })
	}
}

const endpoint = 'https://greetings.example.invalid/'
const env = { GREETING_SOURCE: endpoint }
let current = {
	application: demoApplication(plugins),
	consumerAddress: plugins.Consumer.nodeAddress(),
}
const worker = createWorkerHost((startup) => current.application(startup), {
	coreConfig: demoConfig(endpoint, (input, init) => workerExports.GreetingSource.fetch(input, init))
		.coreConfig,
})

if (import.meta.hot) {
	const hot = import.meta.hot
	await closeOnHotReload(hot, worker)
	import.meta.hot.accept('@pluxel-example/host-targets-plugins', async (next) => {
		try {
			if (!next) throw new Error('Worker plugin module failed to evaluate. See the Vite log.')
			const candidate = {
				application: demoApplication({ Provider: next.Provider, Consumer: next.Consumer }),
				consumerAddress: next.Consumer.nodeAddress(),
			}
			const report = await worker.updateCatalog(
				(startup) => candidate.application(startup).plugins.map(({ plugin }) => plugin),
				{
					onGraphCommitted() {
						current = candidate
					},
				},
			)
			assertDemoUpdate(report)
			hot.send(demoUpdateEvent, { host: 'cloudflare' } satisfies DemoUpdate)
		} catch (error) {
			hot.send(demoUpdateEvent, { host: 'cloudflare', error: String(error) } satisfies DemoUpdate)
		}
	})
	hot.on('vite:error', ({ err }) => {
		hot.send(demoUpdateEvent, { host: 'cloudflare', error: err.message } satisfies DemoUpdate)
	})
}

export default {
	async fetch(request, _env, ctx) {
		if (new URL(request.url).pathname !== '/api/cloudflare') {
			return new Response('Not found', { status: 404 })
		}
		if (request.method !== 'POST') {
			return new Response('Use POST', { status: 405, headers: { allow: 'POST' } })
		}

		return worker.run({ env, signal: request.signal, ctx }, async (sdk) =>
			Response.json(
				await readDemo(sdk, {
					address: current.consumerAddress,
					target: 'cloudflare',
					signal: request.signal,
				}),
			),
		)
	},
} satisfies ExportedHandler
