// packages/components/src/extension/registry.ts

import {
	createContext,
	Fragment,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import {
	isExtensionPluginRunning,
	toGlobalExtensionContext,
	type ExtensionContext,
	type ExtensionItem,
	type ExtensionMeta,
	type ExtensionPoint,
	type ExtensionPointCtx,
	type PluginExtensionContext,
	type GlobalExtensionContext,
} from './types'

// 稳定的空数组引用，避免 useSyncExternalStore 无限循环
const EMPTY_ITEMS: ExtensionItem[] = []

/**
 * 扩展注册表
 */
class ExtensionRegistry {
	private extensions = new Map<ExtensionPoint, Map<string, ExtensionItem<any>>>()
	private listeners = new Set<() => void>()
	private version = 0
	private snapshotCache = new Map<ExtensionPoint, ExtensionItem<any>[]>()

	/**
	 * 注册扩展
	 */
	register<P extends ExtensionPoint>(point: P, item: ExtensionItem<P>): () => void {
		let bucket = this.extensions.get(point)
		if (!bucket) {
			bucket = new Map()
			this.extensions.set(point, bucket)
		}

		bucket.set(item.meta.id, item)
		this.invalidateCache(point)
		this.notify()

		return () => {
			bucket?.delete(item.meta.id)
			if (bucket?.size === 0) {
				this.extensions.delete(point)
			}
			this.invalidateCache(point)
			this.notify()
		}
	}

	/**
	 * 批量注册
	 */
	registerMany(items: Array<{ point: ExtensionPoint; item: ExtensionItem<any> }>): () => void {
		const cleanups: Array<() => void> = []
		for (const { point, item } of items) {
			cleanups.push(this.register(point as any, item as any))
		}
		return () => cleanups.forEach((fn) => fn())
	}

	/**
	 * 获取扩展点的所有扩展（已排序）
	 */
	get<P extends ExtensionPoint>(point: P): ExtensionItem<P>[] {
		const cached = this.snapshotCache.get(point)
		if (cached) return cached as ExtensionItem<P>[]

		const bucket = this.extensions.get(point)
		if (!bucket) return EMPTY_ITEMS as ExtensionItem<P>[] // 使用稳定的空数组

		const items = Array.from(bucket.values()).sort((a, b) => {
			const prio = b.meta.priority - a.meta.priority
			if (prio !== 0) return prio
			return a.meta.id.localeCompare(b.meta.id)
		})
		this.snapshotCache.set(point, items)
		return items as ExtensionItem<P>[]
	}

	/**
	 * 获取快照（用于 useSyncExternalStore）
	 */
	getSnapshot = <P extends ExtensionPoint>(point: P): ExtensionItem<P>[] => {
		return this.get(point)
	}

	/**
	 * 订阅变化
	 */
	subscribe = (cb: () => void): (() => void) => {
		this.listeners.add(cb)
		return () => this.listeners.delete(cb)
	}

	/**
	 * 清空所有扩展
	 */
	clear(): void {
		this.extensions.clear()
		this.snapshotCache.clear()
		this.notify()
	}

	/**
	 * 获取版本号
	 */
	getVersion(): number {
		return this.version
	}

	private invalidateCache(point: ExtensionPoint): void {
		this.snapshotCache.delete(point)
	}

	private notify(): void {
		this.version++
		this.listeners.forEach((cb) => {
			try {
				cb()
			} catch {}
		})
	}
}

// 全局单例
export const extensionRegistry = new ExtensionRegistry()

/**
 * 扩展上下文 Context
 */
const ExtensionCtx = createContext<ExtensionContext | null>(null)

export interface ExtensionProviderProps {
	value: ExtensionContext
	children: ReactNode
}

/**
 * 扩展上下文 Provider
 */
export function ExtensionProvider({ value, children }: ExtensionProviderProps) {
	return <ExtensionCtx.Provider value={value}>{children}</ExtensionCtx.Provider>
}

/**
 * 获取扩展上下文
 */
export function useExtensionContext(): ExtensionContext {
	const ctx = useContext(ExtensionCtx)
	if (!ctx) {
		throw new Error('useExtensionContext must be used within ExtensionProvider')
	}
	return ctx
}

/**
 * 尝试获取扩展上下文（不抛错）
 */
export function useExtensionContextMaybe(): ExtensionContext | null {
	return useContext(ExtensionCtx)
}

/**
 * Hook: 获取扩展点的扩展
 */
export function useExtensions<P extends ExtensionPoint>(point: P) {
	return useExtensionsWithContext(point)
}

/**
 * Hook: 获取扩展点的扩展（支持上下文覆盖）
 *
 * @param point 扩展点
 * @param contextOverride 额外上下文（会与全局上下文合并）
 */
export function useExtensionsWithContext<P extends ExtensionPoint>(point: P) {
	const globalCtx = useExtensionContextMaybe()

	const ctx = useMemo(() => globalCtx, [globalCtx])

	// 订阅 registry 变化
	const items = useSyncExternalStore(
		extensionRegistry.subscribe,
		() => extensionRegistry.getSnapshot(point),
		() => extensionRegistry.getSnapshot(point),
	)

	const ctxForPoint = useMemo<ExtensionPointCtx<P> | null>(() => {
		if (!ctx) return null
		if (point.startsWith('plugin:')) {
			if (!('pluginName' in ctx)) return null
			return ctx as PluginExtensionContext as ExtensionPointCtx<P>
		}
		return toGlobalExtensionContext(ctx) as GlobalExtensionContext as ExtensionPointCtx<P>
	}, [ctx, point])

	// 如果没有 context，返回空（安全降级）
	const visible = useMemo(() => {
		if (!ctxForPoint) return []

		return items.filter((item) => {
			// when 条件
			if (item.when && !item.when(ctxForPoint as any)) return false

			// requireRunning 检查
			if (
				item.meta.requireRunning &&
				item.meta.pluginName !== '__static__' &&
				!isExtensionPluginRunning(ctxForPoint as any, item.meta.pluginName)
			) {
				return false
			}

			// 插件名匹配（plugin:* 扩展点需要匹配当前插件）
			if (point.startsWith('plugin:')) {
				const pluginCtx = ctxForPoint as unknown as PluginExtensionContext
				const extPluginName = item.meta.pluginName
				if (
					extPluginName &&
					extPluginName !== '__static__' &&
					extPluginName !== pluginCtx.pluginName
				) {
					return false
				}
			}

			return true
		})
	}, [items, ctxForPoint, point])

	// 渲染节点
	const nodes = useMemo(() => {
		if (!ctxForPoint) return []
		return visible.map((item) => (
			<Fragment key={item.meta.id}>{item.render(ctxForPoint as any)}</Fragment>
		))
	}, [visible, ctxForPoint])

	return { items: visible as ExtensionItem<P>[], nodes, context: ctxForPoint }
}

/**
 * Hook: 手动注册扩展
 */
export function useRegisterExtension() {
	const seqRef = useRef(0)
	const register = useCallback(
		(
			point: ExtensionPoint,
			options: {
				id?: string
				pluginName?: string
				priority?: number
				requireRunning?: boolean
				when?: (ctx: any) => boolean
				render: (ctx: any) => ReactNode
				meta?: Record<string, unknown>
			},
		) => {
			const id = options.id ?? `manual:${point}:${++seqRef.current}`
			const meta: ExtensionMeta = {
				id,
				pluginName: options.pluginName ?? '__manual__',
				priority: options.priority ?? 0,
				requireRunning: options.requireRunning ?? false,
				...options.meta,
			}

			return extensionRegistry.register(
				point as any,
				{
					meta,
					when: options.when,
					render: options.render,
				} as any,
			)
		},
		[],
	)

	return { register }
}
