import { request } from 'launcher:bridge'
import { encodeJson, type NativeTransport } from '@embedded-launcher/sdk'
let sequence = 0
export const transport: NativeTransport = {
	async request(method, params, signal) {
		signal?.throwIfAborted()
		const id = ++sequence
		const cancel = () => {
			void request(
				encodeJson({ jsonrpc: '2.0', id: ++sequence, method: '$/cancelRequest', params: { id } }),
			).catch((error) => console.error('Native cancellation delivery failed', error))
		}
		signal?.addEventListener('abort', cancel, { once: true })
		try {
			const reply = JSON.parse(await request(encodeJson({ jsonrpc: '2.0', id, method, params })))
			if (reply.jsonrpc !== '2.0' || reply.id !== id)
				throw new Error('Native response identity mismatch')
			if (reply.error) throw new Error(reply.error.message)
			return reply.result
		} finally {
			signal?.removeEventListener('abort', cancel)
		}
	},
}
