import { createServer, type ViteDevServer } from 'vite'
import { dynamicRuntimeVitePlugin } from './vite'

export type OwnedDynamicRuntimeViteServer = Readonly<{
	server: ViteDevServer
	origin: string
}>

export async function startOwnedDynamicRuntimeViteServer(
	options: Readonly<{
		entry: string
		root: string
		signal?: AbortSignal
	}>,
): Promise<OwnedDynamicRuntimeViteServer> {
	throwIfAborted(options.signal)
	let server: ViteDevServer | undefined
	let listenOperation: Promise<ViteDevServer> | undefined
	try {
		server = await createServer({
			configFile: false,
			root: options.root,
			plugins: dynamicRuntimeVitePlugin({ entry: options.entry }),
			server: { host: '127.0.0.1', port: 0, strictPort: true },
		})
		throwIfAborted(options.signal)
		listenOperation = server.listen()
		await waitForStartup(listenOperation, options.signal)
		throwIfAborted(options.signal)
		return Object.freeze({ server, origin: readViteOrigin(server) })
	} catch (error) {
		if (!server) throw error
		const cleanupErrors: unknown[] = []
		try {
			await server.close()
		} catch (closeError) {
			cleanupErrors.push(closeError)
		}
		try {
			await listenOperation
		} catch (listenError) {
			if (listenError !== error) cleanupErrors.push(listenError)
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], '[runtime-dynamic] startup failed', {
				cause: error,
			})
		}
		throw error
	}
}

function readViteOrigin(server: ViteDevServer): string {
	const address = server.httpServer?.address()
	if (!address || typeof address === 'string') {
		throw new Error('[runtime-dynamic] Vite listener did not publish a TCP address')
	}
	return `http://127.0.0.1:${address.port}`
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return
	throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function waitForStartup<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation
	throwIfAborted(signal)
	return new Promise<T>((resolve, reject) => {
		const onAbort = () =>
			reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
		signal.addEventListener('abort', onAbort, { once: true })
		operation.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				return resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				return reject(error)
			},
		)
	})
}
