// packages/components/src/extension/slots/ExtensionSlot.tsx

import type { ReactNode } from 'react'
import type { ExtensionPoint } from '@pluxel/runtime/web/ui'
import { useExtensionSurface } from './ExtensionSurface'

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
