import type { FetchRequest, FetchResponse } from '../shared/contracts.ts'

const port = process.parentPort
if (!port) throw new Error('Studio backend must run in an Electron utility process')
const [root, assetsRoot] = process.argv.slice(2)
if (!root || !assetsRoot) throw new Error('Studio backend requires data and asset roots')
if (process.env.STUDIO_DEV === '1' && !process.env.STUDIO_PROJECT_ROOT)
	throw new Error('Studio development requires STUDIO_PROJECT_ROOT')
let backend: Awaited<ReturnType<typeof import('../backend/runtime.ts').startBackend>>
if (process.env.STUDIO_DEV === '1') {
	const { startDevBackend } = await import('../backend/dev.ts')
	backend = await startDevBackend({ root, assetsRoot }, process.env.STUDIO_PROJECT_ROOT!)
} else {
	const { startBackend } = await import('../backend/runtime.ts')
	backend = await startBackend({ root, assetsRoot })
}
let closing = false
port.on(
	'message',
	async ({ data }: { data: { id: number; request?: FetchRequest; close?: boolean } }) => {
		if (data.close) {
			closing = true
			try {
				await backend.close()
				port.postMessage({ id: data.id, closed: true })
			} catch (error) {
				port.postMessage({ id: data.id, error: String(error) })
			}
			return
		}
		try {
			if (closing || !data.request) throw new Error('Studio backend is closing')
			const input = data.request
			const response = await backend.fetch(
				new Request(`http://studio.local${input.path}`, {
					method: input.method,
					headers: input.headers,
					...(input.body && { body: new Uint8Array(input.body) }),
				}),
			)
			const result: FetchResponse = {
				status: response.status,
				headers: [...response.headers],
				body: new Uint8Array(await response.arrayBuffer()),
			}
			port.postMessage({ id: data.id, result })
		} catch (error) {
			port.postMessage({
				id: data.id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	},
)
port.postMessage({ ready: true })
