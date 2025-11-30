// packages/components/src/extension/slots/ExtensionSlot.tsx

import type { ReactNode } from 'react'
import { useExtensionSurface } from './ExtensionSurface'
import type { ExtensionContext, ExtensionPoint, ExtensionItem } from '../types'

export interface ExtensionSlotProps {
	/** 扩展点 */
	point: ExtensionPoint
	/** 无扩展时的后备内容 */
	fallback?: ReactNode
	/** 自定义渲染包装 */
	wrapper?: (nodes: ReactNode[]) => ReactNode
	/** 自定义容器 className */
	className?: string
	/** 上下文覆盖/合并（用于插件特定上下文） */
	context?: Partial<ExtensionContext>
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
 *   context={{ pluginName: 'MyPlugin', isPluginRunning: true }}
 * />
 * ```
 */
export function ExtensionSlot({ point, fallback, wrapper, className, context }: ExtensionSlotProps) {
	const { nodes, hasFill } = useExtensionSurface(point, { context })

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

export interface ExtensionSlotRenderProps {
	/** 扩展点 */
	point: ExtensionPoint
	/** 上下文覆盖/合并 */
	context?: Partial<ExtensionContext>
	/** 渲染函数 */
	children: (info: {
		nodes: ReactNode[]
		items: Array<{ meta: ExtensionItem['meta'] }>
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
export function ExtensionSlotRender({ point, context, children }: ExtensionSlotRenderProps) {
	const surface = useExtensionSurface(point, { context })

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
