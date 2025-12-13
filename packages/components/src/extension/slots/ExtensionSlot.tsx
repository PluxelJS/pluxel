// packages/components/src/extension/slots/ExtensionSlot.tsx

import type { ReactNode } from 'react'
import { useExtensionSurface } from './ExtensionSurface'
import type { ExtensionPoint, ExtensionItem } from '../types'

export interface ExtensionSlotProps<P extends ExtensionPoint = ExtensionPoint> {
	/** 扩展点 */
	point: P
	/** 无扩展时的后备内容 */
	fallback?: ReactNode
	/** 自定义渲染包装 */
	wrapper?: (nodes: ReactNode[]) => ReactNode
	/** 自定义容器 className */
	className?: string
}

/**
 * 扩展插槽组件
 *
 * 在指定位置渲染所有注册的扩展
 *
 * @example
 * ```tsx
 * // 基础用法
 * <ExtensionSlot point="header:actions" />
 *
 * // 带插件上下文
 * <ExtensionSlot
 *   point="plugin:tabs"
 * />
 * ```
 */
export function ExtensionSlot<P extends ExtensionPoint>({
	point,
	fallback,
	wrapper,
	className,
}: ExtensionSlotProps<P>) {
	const { nodes, hasFill } = useExtensionSurface(point)

	if (!hasFill) {
		return <>{fallback}</>
	}

	if (wrapper) {
		return <>{wrapper(nodes)}</>
	}

	if (className) {
		return <div className={className}>{nodes}</div>
	}

	return <>{nodes}</>
}

export interface ExtensionSlotRenderProps<P extends ExtensionPoint = ExtensionPoint> {
	/** 扩展点 */
	point: P
	/** 渲染函数 */
	children: (info: {
		nodes: ReactNode[]
		items: Array<{ meta: ExtensionItem<P>['meta'] }>
		hasFill: boolean
	}) => ReactNode
}

/**
 * 扩展插槽（Render Props 版本）
 *
 * 提供更灵活的渲染控制
 *
 * @example
 * ```tsx
 * <ExtensionSlotRender
 *   point="plugin:tabs"
 *   context={{ pluginName: 'MyPlugin' }}
 * >
 *   {({ nodes, items, hasFill }) => (
 *     <>
 *       {items.map(item => <Tab key={item.meta.id} label={item.meta.label} />)}
 *       {nodes}
 *     </>
 *   )}
 * </ExtensionSlotRender>
 * ```
 */
export function ExtensionSlotRender<P extends ExtensionPoint>({
	point,
	children,
}: ExtensionSlotRenderProps<P>) {
	const surface = useExtensionSurface(point)

	return (
		<>
			{children({
				nodes: surface.nodes,
				items: surface.items.map(({ meta }) => ({ meta })),
				hasFill: surface.hasFill,
			})}
		</>
	)
}
