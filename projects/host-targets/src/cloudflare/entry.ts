import { WorkerEntrypoint } from 'cloudflare:workers'
import { createHost } from '@pluxel/host/cloudflare'
import { demoOptions, runDemo, startDemo } from '../demo'

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

export default {
	async fetch(request, _env, ctx) {
		if (new URL(request.url).pathname !== '/api/cloudflare') {
			return new Response('Not found', { status: 404 })
		}
		if (request.method !== 'POST') {
			return new Response('Use POST', { status: 405, headers: { allow: 'POST' } })
		}

		const source = ctx.exports.GreetingSource
		await using host = await createHost(
			demoOptions('https://greetings.example.invalid/', (input, init) => source.fetch(input, init)),
		)
		await startDemo(host)
		return Response.json(await runDemo(host, 'cloudflare', request.signal))
	},
} satisfies ExportedHandler
