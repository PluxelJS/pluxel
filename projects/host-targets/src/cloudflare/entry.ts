import { WorkerEntrypoint } from 'cloudflare:workers'
import { createHost } from '@pluxel/host/cloudflare'
import { runDemo, startDemo } from '../demo'
import * as initialPlugins from '../demo-plugins'
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

type PluginModule = typeof initialPlugins
let current: { plugins: PluginModule } | { error: string } = { plugins: initialPlugins }
if (import.meta.hot) {
	const hot = import.meta.hot
	import.meta.hot.accept('../demo-plugins', (updated) => {
		const next = updated as Partial<PluginModule> | undefined
		if (!next) {
			current = { error: 'Worker plugin module failed to evaluate. See the Vite log.' }
		} else if (typeof next.demoOptions !== 'function' || !next.consumerAddress) {
			current = { error: 'Worker plugin module is missing its demo exports.' }
		} else {
			const { demoOptions, consumerAddress } = next
			current = { plugins: { demoOptions, consumerAddress } }
		}
		hot.send(demoUpdateEvent, {
			host: 'cloudflare',
			error: 'error' in current ? current.error : undefined,
		} satisfies DemoUpdate)
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

		if ('error' in current) return new Response(current.error, { status: 503 })
		const { demoOptions, consumerAddress } = current.plugins
		const source = ctx.exports.GreetingSource
		await using host = await createHost(
			demoOptions('https://greetings.example.invalid/', (input, init) => source.fetch(input, init)),
		)
		await startDemo(host)
		return Response.json(
			await runDemo(host, {
				address: consumerAddress,
				target: 'cloudflare',
				signal: request.signal,
			}),
		)
	},
} satisfies ExportedHandler
