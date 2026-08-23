import {
	createAdminAccessAwareFetch,
	type AdminAccessAwareFetchOptions,
	type RuntimeFetch,
} from './admin-access'
import { resolveClientUrl } from './http-utils'
import { joinPath, RUNTIME_INTERNAL_API_BASE, RUNTIME_TRANSPORT_PATHS } from './paths'

export type RuntimeClientConnectionOptions = Readonly<{
	origin?: string
	apiBase?: string
	rpcBase?: string
	credentials?: RequestCredentials
	fetch?: RuntimeFetch
	adminAccess?: false | AdminAccessAwareFetchOptions
}>

export type RuntimeClientConnection = Readonly<{
	apiBase: string
	rpcBase: string
	credentials: RequestCredentials
	fetch: RuntimeFetch
}>

function resolveApiBase(options: RuntimeClientConnectionOptions): string {
	return resolveClientUrl(
		options.apiBase ??
			(typeof options.origin === 'string' && options.origin
				? joinPath(options.origin, RUNTIME_INTERNAL_API_BASE)
				: RUNTIME_INTERNAL_API_BASE),
	)
}

function resolveBaseFetch(options: RuntimeClientConnectionOptions): RuntimeFetch {
	const fetchImpl =
		options.fetch ??
		(typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
	if (!fetchImpl) {
		throw new Error('[runtime-web] global fetch is unavailable; pass `options.fetch` explicitly.')
	}
	return fetchImpl
}

function withDefaultCredentials(
	baseFetch: RuntimeFetch,
	credentials: RequestCredentials,
): RuntimeFetch {
	return (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.credentials !== undefined) return baseFetch(input as any, init as any)
		const isRequest = typeof Request === 'function' && input instanceof Request
		if (!init && isRequest) return baseFetch(input as any, init as any)
		return baseFetch(input as any, { ...init, credentials } as any)
	}
}

export function resolveRuntimeClientConnection(
	options: RuntimeClientConnectionOptions = {},
): RuntimeClientConnection {
	const apiBase = resolveApiBase(options)
	const credentials = options.credentials ?? 'same-origin'
	const baseFetch = withDefaultCredentials(resolveBaseFetch(options), credentials)
	const fetch =
		options.adminAccess === false
			? baseFetch
			: createAdminAccessAwareFetch(baseFetch, options.adminAccess)
	return Object.freeze({
		apiBase,
		rpcBase: resolveClientUrl(options.rpcBase ?? joinPath(apiBase, RUNTIME_TRANSPORT_PATHS.rpc)),
		credentials,
		fetch,
	})
}
