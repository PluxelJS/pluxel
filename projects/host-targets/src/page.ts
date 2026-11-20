import type { BrowserCommand, BrowserReply } from './browser.worker'
import type { DemoHost, DemoResult } from './demo'
import './page.css'

function createBrowserWorker() {
	const worker = new Worker(new URL('./browser.worker.ts', import.meta.url), { type: 'module' })
	const lifetime = new AbortController()
	worker.addEventListener('error', (event) =>
		lifetime.abort(new Error(event.message || 'Browser Host did not start')),
	)

	function call(command: BrowserCommand): Promise<BrowserReply> {
		lifetime.signal.throwIfAborted()
		const { port1, port2 } = new MessageChannel()
		return new Promise((resolve, reject) => {
			const abort = () => {
				port1.close()
				reject(lifetime.signal.reason)
			}
			lifetime.signal.addEventListener('abort', abort, { once: true })
			port1.onmessage = ({ data }: MessageEvent<BrowserReply>) => {
				lifetime.signal.removeEventListener('abort', abort)
				port1.close()
				resolve(data)
			}
			worker.postMessage(command, [port2])
		})
	}

	return {
		call,
		async close() {
			try {
				if (!lifetime.signal.aborted) {
					const reply = await call('close')
					if (reply.kind === 'error') throw new Error(reply.message)
				}
			} finally {
				lifetime.abort()
				worker.terminate()
			}
		},
	}
}

let browser = Promise.resolve(createBrowserWorker())

async function show(host: DemoHost, read: () => Promise<DemoResult>) {
	const output = document.querySelector<HTMLElement>(`[data-host="${host}"]`)!
	try {
		output.textContent = JSON.stringify(await read(), null, 2)
	} catch (error) {
		output.textContent = String(error)
	}
}

async function readBrowser(): Promise<DemoResult> {
	const current = await browser
	const result = await current.call('read')
	if (result.kind === 'result') return result.value
	throw new Error(result.kind === 'error' ? result.message : 'Browser Host closed')
}

async function readServer(host: 'node' | 'cloudflare'): Promise<DemoResult> {
	const response = await fetch(`/api/${host}`, { method: 'POST' })
	if (!response.ok) throw new Error(await response.text())
	return await response.json()
}

async function refresh() {
	await Promise.all([
		show('browser', readBrowser),
		show('cloudflare', () => readServer('cloudflare')),
		...(import.meta.env.DEV ? [show('node', () => readServer('node'))] : []),
	])
}

if (!import.meta.env.DEV) document.querySelector('[data-section="node"]')?.remove()

document.querySelector('button')!.addEventListener('click', () => void refresh())
window.addEventListener('pagehide', () => {
	void browser.then((current) => current.close()).catch((error) => console.error(error))
})

import.meta.hot?.on('host-targets:browser-worker-update', () => {
	browser = browser.then(async (current) => {
		await current.close().catch((error) => console.error(error))
		return createBrowserWorker()
	})
	void show('browser', readBrowser)
})

void refresh()
