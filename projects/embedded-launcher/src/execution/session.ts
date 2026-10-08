import { createHost, type PluginHost, type HostDocumentStorage } from '@pluxel/host'
import { encodeJson, type NativeTransport } from '@embedded-launcher/sdk'
import app from '../app'
import type { PluginConstructor } from '@pluxel/core'
export function createSession(
	transport: NativeTransport,
	storage?: { configStorage: HostDocumentStorage; stateStorage: HostDocumentStorage },
	plugins: readonly PluginConstructor[] = [],
) {
	let host: PluginHost | undefined
	let starting: Promise<PluginHost> | undefined
	let closing: Promise<void> | undefined
	let dispatch: ((text: string) => Promise<string>) | undefined
	let closed = false
	function start(): Promise<PluginHost> {
		if (closed) return Promise.reject(new Error('Execution session closed'))
		starting ??= (async () => {
			const application = await app({
				root: '.',
				mode: 'production',
				env: {},
				bindings: {
					transport,
					...storage,
					plugins,
					attachHost(input: { dispatch(text: string): Promise<string> }) {
						dispatch = input.dispatch
						return async () => {
							dispatch = undefined
						}
					},
				},
			})
			const { prepare, ...options } = application
			const created = await createHost(options)
			host = created
			try {
				await prepare({
					host: created,
					startup: { root: '.', mode: 'production', env: {}, bindings: {} },
				})
				await created.start()
				return created
			} catch (error) {
				const [cleanup] = await Promise.allSettled([created.close()])
				if (cleanup.status === 'rejected')
					throw new AggregateError([error, cleanup.reason], 'Host startup and cleanup failed', {
						cause: error,
					})
				throw error
			}
		})()
		return starting
	}
	return {
		async dispatch(text: string): Promise<string> {
			try {
				await start()
				if (!dispatch) throw new Error('Host unavailable')
				return await dispatch(text)
			} catch (error) {
				let id: unknown = null
				try {
					id = JSON.parse(text).id ?? null
				} catch {}
				return encodeJson({
					jsonrpc: '2.0',
					id,
					error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
				})
			}
		},
		close(): Promise<void> {
			if (closing) return closing
			closed = true
			closing = (async () => {
				if (starting) await starting.catch((): void => {})
				await host?.close()
			})()
			return closing
		},
	}
}
