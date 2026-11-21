import type { BrowserCommand, BrowserReply } from './browser.worker'
import { demoUpdateEvent, type DemoHost, type DemoResult, type DemoUpdate } from './protocol'
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
const currentReads = new Map<DemoHost, AbortController>()

function stopRead(host: DemoHost) {
	currentReads.get(host)?.abort()
	currentReads.delete(host)
}

function outputFor(host: DemoHost) {
	return document.querySelector<HTMLElement>(`[data-host="${host}"]`)!
}

async function refreshHost(host: DemoHost) {
	stopRead(host)
	const controller = new AbortController()
	currentReads.set(host, controller)
	const output = outputFor(host)
	output.setAttribute('aria-busy', 'true')
	try {
		const result =
			host === 'browser' ? await readBrowser() : await readServer(host, controller.signal)
		if (!controller.signal.aborted) output.textContent = JSON.stringify(result, null, 2)
	} catch (error) {
		if (!controller.signal.aborted) output.textContent = String(error)
	} finally {
		if (currentReads.get(host) === controller) {
			currentReads.delete(host)
			output.removeAttribute('aria-busy')
		}
	}
}

async function readBrowser(): Promise<DemoResult> {
	const current = await browser
	const result = await current.call('read')
	if (result.kind === 'result') return result.value
	throw new Error(result.kind === 'error' ? result.message : 'Browser Host closed')
}

async function readServer(host: 'node' | 'cloudflare', signal: AbortSignal): Promise<DemoResult> {
	const response = await fetch(`/api/${host}`, { method: 'POST', signal })
	if (!response.ok) throw new Error(await response.text())
	return await response.json()
}

function refresh() {
	void refreshHost('browser')
	void refreshHost('cloudflare')
	if (import.meta.env.DEV) void refreshHost('node')
}

if (!import.meta.env.DEV) document.querySelector('[data-section="node"]')?.remove()

document.querySelector('button')!.addEventListener('click', refresh)
window.addEventListener('pagehide', () => {
	for (const host of currentReads.keys()) stopRead(host)
	void browser.then((current) => current.close()).catch((error) => console.error(error))
})

import.meta.hot?.on(demoUpdateEvent, ({ host, error }: DemoUpdate) => {
	if (error) {
		stopRead(host)
		const output = outputFor(host)
		output.textContent = error
		output.removeAttribute('aria-busy')
		return
	}
	if (host === 'browser') {
		browser = browser.then(async (current) => {
			await current.close()
			return createBrowserWorker()
		}, createBrowserWorker)
	}
	void refreshHost(host)
})

refresh()
