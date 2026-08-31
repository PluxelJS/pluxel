import type { PluginConstructor } from '@pluxel/core'
import { newWebSocketRpcSession, type RpcStub } from '@pluxel/runtime/capnweb'
import { createWorkbenchBackend } from '@pluxel/runtime/internal/static'
import { RUNTIME_SESSION_PATH, type RuntimeSessionRoot } from '@pluxel/runtime/web/session'
import NodeWebSocket from 'crossws/websocket'
import { startStaticRuntimeApplication } from './internal/application.ts'
import type {
	StaticRuntime,
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeEnvironment,
} from './types.ts'

export type RuntimeSessionTestConnection = Disposable &
	Readonly<{
		socket: WebSocket
		root: RpcStub<RuntimeSessionRoot>
	}>

/** Opens the origin-checked Runtime Session through the same Node WebSocket carrier as production. */
export async function openRuntimeSessionTestConnection(
	origin: string,
	options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<RuntimeSessionTestConnection> {
	const normalizedOrigin = normalizeTestOrigin(origin)
	const socketUrl = new URL(RUNTIME_SESSION_PATH, normalizedOrigin)
	socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
	const WebSocketConstructor = NodeWebSocket as unknown as new (
		url: string,
		protocols: string[],
		options: { headers: Record<string, string> },
	) => WebSocket
	const socket = new WebSocketConstructor(socketUrl.href, [], {
		headers: { origin: normalizedOrigin.origin },
	})
	try {
		await waitForTestSocketOpen(socket, options.signal)
	} catch (error) {
		socket.close()
		throw error
	}
	const root = newWebSocketRpcSession<RuntimeSessionRoot>(socket)
	let active = true
	return Object.freeze({
		socket,
		root,
		[Symbol.dispose]() {
			if (!active) return
			active = false
			root[Symbol.dispose]()
			socket.close()
		},
	})
}

export function createStaticRuntimeTestHost<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: {
		env?: StaticRuntimeEnvironment
		bindings?: TBindings
	} = {},
): Promise<StaticRuntime> {
	return startStaticRuntimeApplication(application, {
		startup: {
			mode: 'test',
			env: options.env ?? {},
			bindings: options.bindings ?? ({} as TBindings),
		},
		createWorkbenchBackend,
	})
}

function normalizeTestOrigin(input: string): URL {
	let origin: URL
	try {
		origin = new URL(input)
	} catch (cause) {
		throw new TypeError('Runtime Session test origin must be an absolute HTTP(S) origin', {
			cause,
		})
	}
	if (
		(origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
		origin.username ||
		origin.password ||
		origin.pathname !== '/' ||
		origin.search ||
		origin.hash
	) {
		throw new TypeError('Runtime Session test origin must be an absolute HTTP(S) origin')
	}
	return origin
}

function waitForTestSocketOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason)
	if (socket.readyState === WebSocket.OPEN) return Promise.resolve()
	return new Promise((resolveOpen, reject) => {
		const cleanup = () => {
			socket.removeEventListener('open', onOpen)
			socket.removeEventListener('error', onError)
			socket.removeEventListener('close', onClose)
			signal?.removeEventListener('abort', onAbort)
		}
		const onOpen = () => {
			cleanup()
			resolveOpen()
		}
		const onError = () => {
			cleanup()
			reject(new Error('Runtime Session test WebSocket connection failed'))
		}
		const onClose = () => {
			cleanup()
			reject(new Error('Runtime Session test WebSocket closed before opening'))
		}
		const onAbort = () => {
			cleanup()
			reject(signal?.reason)
		}
		socket.addEventListener('open', onOpen, { once: true })
		socket.addEventListener('error', onError, { once: true })
		socket.addEventListener('close', onClose, { once: true })
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}
