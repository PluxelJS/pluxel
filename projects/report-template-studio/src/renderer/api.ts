import type { DesktopApi } from '../shared/contracts'
import { createDesktopClient } from '../rpc/message-port'

/** The renderer owns one dedicated MessagePort RPC session. */
export let api: DesktopApi

export async function connectDesktop(): Promise<void> {
	const connection = await new Promise<ReturnType<typeof createDesktopClient>>(
		(resolve, reject) => {
			const timer = setTimeout(() => {
				window.removeEventListener('message', receive)
				reject(new Error('Studio backend connection timed out'))
			}, 30_000)
			function receive(event: MessageEvent) {
				if (
					event.source !== window ||
					event.data?.type !== 'studio:port' ||
					event.ports.length !== 1
				)
					return
				clearTimeout(timer)
				window.removeEventListener('message', receive)
				resolve(createDesktopClient(event.ports[0]!))
			}
			window.addEventListener('message', receive)
			window.studio.connect()
		},
	)
	api = connection.api
	window.addEventListener('pagehide', () => connection.disconnect(), { once: true })
}
