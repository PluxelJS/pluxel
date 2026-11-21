import { createHost } from '@pluxel/host/browser'
import { runDemo, startDemo } from './demo'
import { consumerAddress, demoOptions } from './demo-plugins'
import type { DemoResult } from './protocol'

export type BrowserCommand = 'read' | 'close'
export type BrowserReply =
	| { kind: 'result'; value: DemoResult }
	| { kind: 'closed' }
	| { kind: 'error'; message: string }

const worker = globalThis as unknown as DedicatedWorkerGlobalScope
const source = new URL('/greeting.json', worker.location.href).href
const host = await createHost(demoOptions(source))
try {
	await startDemo(host)
} catch (error) {
	await host.close()
	throw error
}

worker.addEventListener('message', ({ data, ports }: MessageEvent<BrowserCommand>) => {
	const reply = ports[0]
	if (!reply) return
	void (async () => {
		try {
			if (data === 'close') {
				await host.close()
				reply.postMessage({ kind: 'closed' } satisfies BrowserReply, [])
			} else if (data === 'read') {
				const value = await runDemo(host, { address: consumerAddress, target: 'browser' })
				reply.postMessage({ kind: 'result', value } satisfies BrowserReply, [])
			}
		} catch (error) {
			reply.postMessage({ kind: 'error', message: String(error) } satisfies BrowserReply, [])
		} finally {
			reply.close()
		}
	})()
})
