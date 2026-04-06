// packages/components/src/extension/internal/registry.ts

import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react'
import {
	ExtensionProvider,
	isExtensionPluginRunning,
	toGlobalExtensionContext,
	type ExtensionContext,
	useExtensionContext,
	type ExtensionItem,
	type ExtensionPoint,
	type ExtensionPointCtx,
	type PluginExtensionContext,
	type GlobalExtensionContext,
} from '@pluxel/runtime/web'

// 稳定的空数组引用，避免 useSyncExternalStore 无限循环
const EMPTY_ITEMS: ExtensionItem[] = []
const EMPTY_NODES: ReactNode[] = []

export interface UseExtensionsOptions {
	renderNodes?: boolean
}

/**
 * 扩展注册表
 */
class ExtensionRegistry {
	private extensions = new Map<ExtensionPoint, Map<string, ExtensionItem<any>>>()
	private listeners = new Set<() => void>()
	private pointListeners = new Map<ExtensionPoint, Set<() => void>>()
	private snapshotCache = new Map<ExtensionPoint, ExtensionItem<any>[]>()
	private batchDepth = 0
	private batchedPoints = new Set<ExtensionPoint>()

	/**
	 * 注册扩展
	 */
	register<P extends ExtensionPoint>(point: P, item: ExtensionItem<P>): () => void {
		let bucket = this.extensions.get(point)
		if (!bucket) {
			bucket = new Map()
			this.extensions.set(point, bucket)
		}

		const id = item.meta.id
		bucket.set(id, item)
		this.invalidateCache(point)
		this.queueNotifyPoints(new Set([point]))

		return () => {
			// Only delete if we're still the active registration for this id
			if (bucket?.get(id) === item) {
				bucket.delete(id)
			}
			if (bucket?.size === 0) {
				this.extensions.delete(point)
			}
			this.invalidateCache(point)
			this.queueNotifyPoints(new Set([point]))
		}
	}

	/**
	 * 批量注册
	 */
	registerMany(items: Array<{ point: ExtensionPoint; item: ExtensionItem<any> }>): () => void {
		if (items.length === 0) return () => {}

		const touched = new Set<ExtensionPoint>()
		const inserted: Array<{ point: ExtensionPoint; id: string; item: ExtensionItem<any> }> = []

		for (const { point, item } of items) {
			if (!point || !item) continue
			let bucket = this.extensions.get(point)
			if (!bucket) {
				bucket = new Map()
				this.extensions.set(point, bucket)
			}
			const id = item.meta.id
			bucket.set(id, item)
			touched.add(point)
			inserted.push({ point, id, item })
		}

		for (const point of touched) {
			this.invalidateCache(point)
		}
		if (touched.size > 0) this.queueNotifyPoints(touched)

		return () => {
			const cleanupTouched = new Set<ExtensionPoint>()
			for (const { point, id, item } of inserted) {
				const bucket = this.extensions.get(point)
				if (!bucket) continue
				// Only delete if we're still the active registration for this id
				if (bucket.get(id) === item && bucket.delete(id)) {
					cleanupTouched.add(point)
					if (bucket.size === 0) {
						this.extensions.delete(point)
					}
				}
			}
			for (const point of cleanupTouched) {
				this.invalidateCache(point)
			}
			if (cleanupTouched.size > 0) this.queueNotifyPoints(cleanupTouched)
		}
	}

	/**
	 * 获取扩展点的所有扩展（已排序）
	 */
	get<P extends ExtensionPoint>(point: P): ExtensionItem<P>[] {
		const cached = this.snapshotCache.get(point)
		if (cached) return cached as ExtensionItem<P>[]

		const bucket = this.extensions.get(point)
		if (!bucket) return EMPTY_ITEMS as unknown as ExtensionItem<P>[] // 使用稳定的空数组

		const items = Array.from(bucket.values()).sort((a, b) => {
			const prio = b.meta.priority - a.meta.priority
			if (prio !== 0) return prio
			return a.meta.id.localeCompare(b.meta.id)
		})
		this.snapshotCache.set(point, items)
		return items as unknown as ExtensionItem<P>[]
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
	 * 订阅某个扩展点的变化（更细粒度，减少无关重渲染）
	 */
	subscribePoint = (point: ExtensionPoint, cb: () => void): (() => void) => {
		let bucket = this.pointListeners.get(point)
		if (!bucket) {
			bucket = new Set()
			this.pointListeners.set(point, bucket)
		}
		bucket.add(cb)
		return () => {
			const current = this.pointListeners.get(point)
			if (!current) return
			current.delete(cb)
			if (current.size === 0) {
				this.pointListeners.delete(point)
			}
		}
	}

	/**
	 * 清空所有扩展
	 */
	clear(): void {
		const touched = new Set<ExtensionPoint>()
		for (const key of this.extensions.keys()) touched.add(key)
		for (const key of this.pointListeners.keys()) touched.add(key)
		this.extensions.clear()
		this.snapshotCache.clear()
		this.queueNotifyPoints(touched)
	}

	/**
	 * Batch registry updates to emit at most one notification.
	 *
	 * Useful when applying many register/unregister operations in a single tick.
	 */
	batch<T>(fn: () => T): T {
		this.batchDepth++
		try {
			return fn()
		} finally {
			this.batchDepth--
			if (this.batchDepth === 0 && this.batchedPoints.size > 0) {
				const points = new Set(this.batchedPoints)
				this.batchedPoints.clear()
				this.notifyPoints(points)
			}
		}
	}

	private invalidateCache(point: ExtensionPoint): void {
		this.snapshotCache.delete(point)
	}

	private queueNotifyPoints(points: Set<ExtensionPoint>): void {
		if (this.batchDepth > 0) {
			for (const p of points) this.batchedPoints.add(p)
			return
		}
		this.notifyPoints(points)
	}

	private notifyPoints(points: Set<ExtensionPoint>): void {
		for (const cb of this.listeners) {
			try {
				cb()
			} catch {}
		}
		for (const point of points) {
			const bucket = this.pointListeners.get(point)
			if (!bucket) continue
			for (const cb of bucket) {
				try {
					cb()
				} catch {}
			}
		}
	}
}

// 全局单例
export const extensionRegistry = new ExtensionRegistry()

/**
 * Hook: 获取扩展点的扩展
 */
export function useExtensions<P extends ExtensionPoint>(
	point: P,
	options: UseExtensionsOptions = {},
) {
	const ctx = useExtensionContext()
	const isPluginPoint = point.startsWith('plugin:')
	const renderNodes = options.renderNodes !== false

	const subscribe = useCallback(
		(listener: () => void) => extensionRegistry.subscribePoint(point, listener),
		[point],
	)
	const getSnapshot = useCallback(() => extensionRegistry.getSnapshot(point), [point])

	// 订阅 registry 变化
	const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	const ctxForPoint = useMemo<ExtensionPointCtx<P> | null>(() => {
		if (isPluginPoint) {
			if (!('pluginName' in ctx)) return null
			return ctx as PluginExtensionContext as ExtensionPointCtx<P>
		}
		return toGlobalExtensionContext(ctx) as GlobalExtensionContext as ExtensionPointCtx<P>
	}, [ctx, isPluginPoint])

	// 对于 plugin:* 扩展点，如果当前不是 plugin ctx，则不渲染（安全降级）。
	const visible = useMemo(() => {
		if (!ctxForPoint) return []

		return items.filter((item) => {
			// requireRunning 检查
			if (
				item.meta.requireRunning &&
				item.meta.pluginName !== '__static__' &&
				!isExtensionPluginRunning(
					ctxForPoint as any,
					item.meta.availabilityPluginName ?? item.meta.pluginName,
				)
			) {
				return false
			}

			// 插件名匹配（plugin:* 扩展点需要匹配当前插件）
			if (isPluginPoint) {
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
	}, [items, ctxForPoint, isPluginPoint])

	// 渲染节点
	const nodes = useMemo(() => {
		if (!renderNodes || !ctxForPoint) return EMPTY_NODES
		// Important: extension components read ctx via hooks. For plugin:* points we must
		// provide a plugin-scoped context even though the root provider is global.
		const scoped = ctxForPoint as unknown as ExtensionContext
		return visible.map((item) => (
			<ExtensionProvider
				key={`${point}:${item.meta.pluginName ?? '__static__'}:${item.meta.id}`}
				value={scoped}
			>
				{item.render(scoped as any)}
			</ExtensionProvider>
		))
	}, [ctxForPoint, point, renderNodes, visible])

	return { items: visible as ExtensionItem<P>[], nodes, context: ctxForPoint }
}
