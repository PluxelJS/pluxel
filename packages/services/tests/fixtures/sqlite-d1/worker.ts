import type { D1Database } from '@cloudflare/workers-types'
import { formatPluginNodeReference } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host/application'
import { createWorkerHost } from '@pluxel/host/cloudflare'
import { d1 } from '@pluxel/services/sqlite/d1'
import { Notes } from './notes'

const owner = formatPluginNodeReference(Notes.nodeAddress())
const fork = Notes.nodeAddress('other')
function start(binding: D1Database) {
	return createWorkerHost(
		defineHostApplication(() => ({
			plugins: [{ plugin: Notes, autoStart: true, forks: { other: { autoStart: true } } }],
			services: [d1({ [owner]: binding, [formatPluginNodeReference(fork)]: binding })],
		})),
	)
}
let host: ReturnType<typeof start>

export default {
	async fetch(
		request: Request,
		env: { DB: D1Database },
		ctx: { waitUntil(promise: Promise<unknown>): void },
	) {
		const { pathname } = new URL(request.url)
		if (pathname === '/owner') return new Response(owner)
		host ??= start(env.DB)
		try {
			return await host.run({ ctx }, async (sdk) => {
				const { instance } = await sdk
					.plugin(pathname === '/fork' ? fork : Notes.nodeAddress())
					.instance()
				if (pathname === '/transactions')
					return Response.json(await instance.supportsInteractiveTransactions())
				return Response.json(await instance.visit(pathname))
			})
		} catch (error) {
			return new Response(error instanceof Error ? error.message : String(error), { status: 409 })
		}
	},
}
