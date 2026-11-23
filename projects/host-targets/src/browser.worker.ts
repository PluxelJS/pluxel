import { startHost } from '@pluxel/host/embedded'
import { demoApplication, demoInputs, assertDemoUpdate, runDemo } from './demo'
import * as plugins from '@pluxel-example/host-targets-plugins'
import type { DemoResult, DemoUpdate } from './protocol'

export type BrowserCommand = 'read' | 'close'
export type BrowserReply =
	| { kind: 'result'; value: DemoResult }
	| { kind: 'closed' }
	| { kind: 'error'; message: string }

const worker = globalThis as unknown as DedicatedWorkerGlobalScope
const source = new URL('/greeting.json', worker.location.href).href
const inputs = demoInputs({ GREETING_SOURCE: source, HOST_PROBE: import.meta.env.VITE_HOST_PROBE })
const { env } = inputs
const ready = startHost(demoApplication(plugins, 'browser'), inputs)
let consumerAddress = plugins.Consumer.nodeAddress()
let settled = Promise.resolve()
if (import.meta.hot) {
	import.meta.hot.accept('@pluxel-example/host-targets-plugins', (next) => {
		settled = settled
			.then(async () => {
				if (!next) throw new Error('Worker plugin module failed to evaluate. See the Vite log.')
				const application = demoApplication(
					{ Provider: next.Provider, Consumer: next.Consumer },
					'browser',
				)
				const { plugins: selected } = await application({ env })
				const address = next.Consumer.nodeAddress()
				const host = await ready
				const report = await host.updateCatalog(
					selected.map(({ plugin }) => plugin),
					{
						onGraphCommitted() {
							consumerAddress = address
						},
					},
				)
				assertDemoUpdate(report)
				return worker.postMessage({ host: 'browser' } satisfies DemoUpdate, [])
			})
			.catch((error) => {
				worker.postMessage({ host: 'browser', error: String(error) } satisfies DemoUpdate, [])
			})
		return settled
	})
}

worker.addEventListener('message', ({ data, ports }: MessageEvent<BrowserCommand>) => {
	const reply = ports[0]
	if (!reply) return
	void (async () => {
		try {
			await settled
			const host = await ready
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

// A module Worker can receive its first message while startup is pending.
await ready
