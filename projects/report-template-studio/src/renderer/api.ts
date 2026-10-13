import type { DesktopApi } from '../shared/contracts'
import { createDesktopClient } from '../rpc/message-port'

/** The renderer owns one dedicated MessagePort RPC session. */
export let api: DesktopApi
const listeners = new Set<(connected: boolean) => void>()
export function onDesktopConnectionChange(listener: (connected: boolean) => void) {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}
function changed(connected: boolean) {
	for (const listener of listeners) listener(connected)
}

export async function connectDesktop(): Promise<void> {
	let connection: ReturnType<typeof createDesktopClient> | undefined
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error('Studio backend connection timed out'))
		}, 30_000)
		function receive(event: MessageEvent) {
			if (
				event.source !== window ||
				event.data?.type !== 'studio:port' ||
				event.ports.length !== 1 ||
				(connection && event.data.replacement !== true)
			)
				return
			clearTimeout(timer)
			const previous = connection
			const next = createDesktopClient(event.ports[0]!)
			connection = next
			api = next.api
			next.api.onRpcBroken(() => {
				if (connection === next) changed(false)
			})
			previous?.disconnect()
			changed(true)
			resolve()
		}
		function cleanup() {
			clearTimeout(timer)
			window.removeEventListener('message', receive)
			window.removeEventListener('pagehide', cleanup)
			const previous = connection
			connection = undefined
			previous?.disconnect()
		}
		window.addEventListener('message', receive)
		window.addEventListener('pagehide', cleanup, { once: true })
		window.studio.connect()
	})
}
