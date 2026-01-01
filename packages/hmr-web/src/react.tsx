import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	createHmrWebClient,
	getHmrWebClient,
	type HmrWebClient,
	type HmrWebClientOptions,
} from './web'
import { defaultOnAuthBlocked, installGlobalAuthFetch } from './auth'
import { sse, type SseClientOptions, type SseClientWithNamespaces } from './sse'
import { mergeNamespaces } from './utils'

import './plugin-ui-augment'
export { invokeRpc, rpcErrorMessage } from './rpc'
export type {
	ExtensionContext,
	GlobalExtensionContext,
	PluginExtensionContext,
} from '@pluxel/plugin-ui'
export type { HmrWebClient, HmrWebClientOptions } from './web'
export type { SseClientOptions, SseClientWithNamespaces } from './sse'

type UseSseClientOptions = SseClientOptions & {
	enabled?: boolean
	autoPauseOnHidden?: boolean
	shared?: boolean
}

type UsePluginSseOptions = UseSseClientOptions & {
	includeLogs?: boolean
	includeExtensions?: boolean
}

const WebClientContext = createContext<HmrWebClient | null>(null)

export function HmrWebClientProvider({
	client,
	options,
	children,
}: {
	client?: HmrWebClient
	options?: HmrWebClientOptions
	children: ReactNode
}) {
	const ref = useRef<HmrWebClient | null>(null)
	if (!ref.current) ref.current = client ?? createHmrWebClient(options)
	const shouldDispose = !client
	useEffect(() => {
		return () => {
			if (shouldDispose) ref.current?.dispose()
		}
	}, [shouldDispose])
	useEffect(() => {
		if (!options?.auth?.globalFetch) return () => {}
		const disposeAuth = installGlobalAuthFetch({
			enabled: options?.auth?.enabled,
			onBlocked: options?.auth?.onBlocked ?? defaultOnAuthBlocked,
			requireMarkerHeader: options?.auth?.requireMarkerHeader,
		})
		return () => disposeAuth()
	}, [
		options?.auth?.globalFetch,
		options?.auth?.enabled,
		options?.auth?.onBlocked,
		options?.auth?.requireMarkerHeader,
	])
	return <WebClientContext.Provider value={ref.current}>{children}</WebClientContext.Provider>
}

export function useHmrWebClient(options?: HmrWebClientOptions): HmrWebClient {
	const ctxClient = useContext(WebClientContext)
	const localRef = useRef<HmrWebClient | null>(null)
	if (!ctxClient && !localRef.current) {
		localRef.current = options ? createHmrWebClient(options) : getHmrWebClient()
	}
	useEffect(() => {
		return () => {
			if (!ctxClient && localRef.current && localRef.current !== getHmrWebClient()) {
				localRef.current.dispose()
			}
		}
	}, [ctxClient])
	return ctxClient ?? localRef.current!
}

const noopDisposer = () => {}
const noopNamespace = { on: () => noopDisposer, onAny: () => noopDisposer }
const noopSseTarget = {
		on: () => noopDisposer,
		onAny: () => noopDisposer,
		onOpen: () => noopDisposer,
		onError: () => noopDisposer,
		ns: () => noopNamespace,
		close: () => {},
	}
const noopSseClient = new Proxy(
	noopSseTarget as unknown as SseClientWithNamespaces,
	{
		get(target, prop, receiver) {
			if (prop === 'ns') return target.ns
			if (typeof prop === 'string' && !(prop in target)) return noopNamespace
			return Reflect.get(target, prop, receiver)
		},
	},
) as unknown as SseClientWithNamespaces

export function useSseClient(options?: UseSseClientOptions): SseClientWithNamespaces {
	const client = useHmrWebClient()
	const autoPauseOnHidden = options?.autoPauseOnHidden ?? true
	const useShared =
		options?.shared !== false && !options?.url && !options?.params && !options?.retry

	const [pageVisible, setPageVisible] = useState(
		typeof document === 'undefined' ? true : document.visibilityState === 'visible',
	)

	useEffect(() => {
		if (!autoPauseOnHidden || typeof document === 'undefined' || useShared) return undefined
		const listener = () => setPageVisible(document.visibilityState === 'visible')
		document.addEventListener('visibilitychange', listener)
		return () => document.removeEventListener('visibilitychange', listener)
	}, [autoPauseOnHidden, useShared])

	const optionsKey = useMemo(
		() => {
			const keyPayload = {
				url: options?.url,
				namespaces: options?.namespaces ?? [],
				params: options?.params ?? {},
				retry: options?.retry ?? {},
			}
			try {
				return JSON.stringify(keyPayload)
			} catch {
				// 避免非 JSON-safe 的 params/retry 导致 hook 直接崩溃；降级为弱键会触发更频繁的重连，但比崩溃更可控。
				return `__nonserializable_options__:${keyPayload.url ?? ''}:${keyPayload.namespaces.join(',')}`
			}
		},
		[options],
	)

	const latestOptions = useRef(options)
	useEffect(() => {
		latestOptions.current = options
	}, [optionsKey])

	const effectiveEnabled = (options?.enabled ?? true) && (!autoPauseOnHidden || pageVisible)

	const [sseClient, setSseClient] = useState<SseClientWithNamespaces>(() => {
		if (useShared) {
			if (typeof window === 'undefined') return noopSseClient
			return client.sse
		}
		if (!effectiveEnabled || typeof window === 'undefined') return noopSseClient
		return client.createSse(latestOptions.current)
	})

	useEffect(() => {
		if (useShared) {
			setSseClient((prev) => {
				const next = typeof window === 'undefined' ? noopSseClient : client.sse
				if (prev !== next && prev !== noopSseClient) prev.close()
				return next
			})
			return undefined
		}
		if (!effectiveEnabled || typeof window === 'undefined') {
			setSseClient((prev) => {
				if (prev !== noopSseClient) prev.close()
				return noopSseClient
			})
			return undefined
		}
		setSseClient((prev) => {
			if (prev !== noopSseClient) prev.close()
			return client.createSse(latestOptions.current)
		})
		return () => {
			setSseClient((prev) => {
				if (prev !== noopSseClient) prev.close()
				return noopSseClient
			})
		}
	}, [client, optionsKey, effectiveEnabled, useShared])

	return sseClient
}

export function usePluginSse(
	pluginName: string,
	options?: UsePluginSseOptions,
): SseClientWithNamespaces {
	const namespaces = mergeNamespaces(
		[pluginName],
		(options?.includeExtensions ?? true) ? ['extensions'] : undefined,
		(options?.includeLogs ?? true) ? ['logs'] : undefined,
		options?.namespaces as any,
	)
	return useSseClient({
		...options,
		namespaces,
	})
}

export function useSharedSseClient(): SseClientWithNamespaces {
	const client = useHmrWebClient()
	if (typeof window === 'undefined') return noopSseClient
	return client.sse
}
