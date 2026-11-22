import { startHost } from '@pluxel/host/browser'
import { assertDemoUpdate, runDemo } from './demo'
import * as plugins from '@pluxel-example/host-targets-plugins'
import { demoApplication } from './demo-plugins'
import { demoConfig } from './demo-config'
import type { DemoResult, DemoUpdate } from './protocol'

export type BrowserCommand = 'read' | 'close'
export type BrowserReply =
	| { kind: 'result'; value: DemoResult }
	| { kind: 'closed' }
	| { kind: 'error'; message: string }

const worker = globalThis as unknown as DedicatedWorkerGlobalScope
const source = new URL('/greeting.json', worker.location.href).href
const env = { GREETING_SOURCE: source }
const host = await startHost(demoApplication(plugins), {
	env,
	coreConfig: demoConfig(source).coreConfig,
})
let consumerAddress = plugins.Consumer.nodeAddress()
let settled = Promise.resolve()
if (import.meta.hot) {
	import.meta.hot.accept('@pluxel-example/host-targets-plugins', (next) => {
		settled = settled
			.then(async () => {
				if (!next) throw new Error('Worker plugin module failed to evaluate. See the Vite log.')
				const application = demoApplication({ Provider: next.Provider, Consumer: next.Consumer })
				const selected = application({ env }).plugins
				const address = next.Consumer.nodeAddress()
				const report = await host.updateCatalog(
					selected.map(({ plugin }) => plugin),
					{
						onGraphCommitted() {
							consumerAddress = address
						},
					},
				)
				assertDemoUpdate(report)
				worker.postMessage({ host: 'browser' } satisfies DemoUpdate)
			})
			.catch((error) => {
				worker.postMessage({ host: 'browser', error: String(error) } satisfies DemoUpdate)
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
