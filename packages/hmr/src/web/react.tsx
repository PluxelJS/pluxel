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
	type ExtensionContext,
	type HmrWebClient,
	mergeNamespaces,
	type SseClientOptions,
	type SseClientWithNamespaces,
	type WebClientOptions,
} from './web'

export { invokeRpc, rpcErrorMessage } from './web'
export type { ExtensionContext, HmrWebClient, WebClientOptions, SseClientWithNamespaces }

type UseSseClientOptions = SseClientOptions & {
	enabled?: boolean
	/** 隐藏标签页时暂停 SSE，减少空闲连接 */
	autoPauseOnHidden?: boolean
	/** 默认复用全局 SSE，避免插件各自再建连接；传 false 强制独享。 */
	shared?: boolean
}

type UsePluginSseOptions = UseSseClientOptions & {
	includeLogs?: boolean
	includeExtensions?: boolean
}

let sharedClient: HmrWebClient | null = null

const noopDisposer = () => {}
const noopNamespace = { on: () => noopDisposer, onAny: () => noopDisposer }
const noopSseClient: SseClientWithNamespaces = new Proxy(
	{
		on: () => noopDisposer,
		onAny: () => noopDisposer,
		onOpen: () => noopDisposer,
		onError: () => noopDisposer,
		ns: () => noopNamespace,
		close: () => {},
	} as SseClientWithNamespaces,
	{
		get(target, prop, receiver) {
			if (prop === 'ns') return target.ns
			if (typeof prop === 'string' && !(prop in target)) return noopNamespace
			return Reflect.get(target, prop, receiver)
		},
	},
)

const WebClientContext = createContext<HmrWebClient | null>(null)

export function HmrWebClientProvider({
	client,
	options,
	children,
}: {
	client?: HmrWebClient
	options?: WebClientOptions
	children: ReactNode
}) {
	const ref = useRef<HmrWebClient | null>(null)
	if (!ref.current) {
		ref.current = client ?? createHmrWebClient(options)
	}
	const shouldDispose = !client
	useEffect(() => {
		return () => {
			if (shouldDispose) {
				ref.current?.dispose()
			}
		}
	}, [shouldDispose])
	return <WebClientContext.Provider value={ref.current}>{children}</WebClientContext.Provider>
}

/**
 * 获取共享的 HMR WebClient。未显式提供 Provider 时会自动创建并在组件卸载时回收。
 */
export function useHmrWebClient(options?: WebClientOptions): HmrWebClient {
	const ctxClient = useContext(WebClientContext)
	const localRef = useRef<HmrWebClient | null>(null)
	if (!ctxClient && !localRef.current) {
		localRef.current = sharedClient ?? createHmrWebClient(options)
		if (!sharedClient) {
			sharedClient = localRef.current
		}
	}
	useEffect(() => {
		return () => {
			if (!ctxClient && localRef.current && localRef.current !== sharedClient) {
				localRef.current.dispose()
			}
		}
	}, [ctxClient])
	return ctxClient ?? localRef.current!
}

/**
 * React 友好的 SSE 客户端：
 * - 支持 enabled 切换
 * - 默认隐藏标签页时暂停（autoPauseOnHidden）
 * - 默认复用全局 SSE，必要时可设 shared=false 获得独享连接
 */
export function useSseClient(options?: UseSseClientOptions): SseClientWithNamespaces {
	const client = useHmrWebClient()
	const autoPauseOnHidden = options?.autoPauseOnHidden ?? true
	const useShared =
		options?.shared !== false && !options?.url && !options?.params && !options?.retry

	const [pageVisible, setPageVisible] = useState(
		typeof document === 'undefined' ? true : document.visibilityState === 'visible',
	)

	useEffect(() => {
		if (!autoPauseOnHidden || typeof document === 'undefined' || useShared) return
		const listener = () => setPageVisible(document.visibilityState === 'visible')
		document.addEventListener('visibilitychange', listener)
		return () => document.removeEventListener('visibilitychange', listener)
	}, [autoPauseOnHidden, useShared])

	const optionsKey = useMemo(() => buildOptionsKey(options), [options])
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
			return
		}
		if (!effectiveEnabled || typeof window === 'undefined') {
			setSseClient((prev) => {
				if (prev !== noopSseClient) prev.close()
				return noopSseClient
			})
			return
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

/**
 * SSE 便捷包装：自动附加插件命名空间，默认订阅 logs/extensions。
 */
export function usePluginSse(
	pluginName: string,
	options?: UsePluginSseOptions,
): SseClientWithNamespaces {
	const namespaces = mergeNamespaces(
		[pluginName],
		(options?.includeExtensions ?? true) ? ['extensions'] : undefined,
		(options?.includeLogs ?? true) ? ['logs'] : undefined,
		options?.namespaces,
	)
	return useSseClient({
		...options,
		namespaces,
	})
}

/** 显式获取全局共享 SSE（与默认 createHmrWebClient 单例绑定） */
export function useSharedSseClient(): SseClientWithNamespaces {
	const client = useHmrWebClient()
	if (typeof window === 'undefined') return noopSseClient
	return client.sse
}

function buildOptionsKey(options?: UseSseClientOptions): string {
	return JSON.stringify({
		url: options?.url,
		namespaces: options?.namespaces ?? [],
		params: options?.params ?? {},
		retry: options?.retry ?? {},
	})
}
