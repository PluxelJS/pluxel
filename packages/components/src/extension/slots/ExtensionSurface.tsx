import { useCallback, useMemo, type ReactNode } from 'react'
import { useExtensionsWithContext } from '../registry'
import type { ExtensionContext, ExtensionPoint, ExtensionItem } from '../types'

export interface ExtensionSurfaceOptions<TMeta = ExtensionItem['meta']> {
	context?: Partial<ExtensionContext>
	projectMeta?: (meta: ExtensionItem['meta']) => TMeta
}

export interface ExtensionSurfaceRenderPayload<TMeta> {
	nodes: ReactNode[]
	items: Array<{ meta: TMeta; item: ExtensionItem }>
	context: ExtensionContext | null
	hasFill: boolean
}

export type ExtensionSurfaceRender<TMeta> = (
	payload: ExtensionSurfaceRenderPayload<TMeta>,
) => ReactNode

export interface ExtensionSurfaceResult<TMeta> {
	nodes: ReactNode[]
	items: Array<{ meta: TMeta; item: ExtensionItem }>
	context: ExtensionContext | null
	hasFill: boolean
	render: (fn: ExtensionSurfaceRender<TMeta>) => ReactNode
}

export function useExtensionSurface<TMeta = ExtensionItem['meta']>(
	point: ExtensionPoint,
	options: ExtensionSurfaceOptions<TMeta> = {},
): ExtensionSurfaceResult<TMeta> {
	const { items, nodes, context } = useExtensionsWithContext(point, options.context)

	const projectedItems = useMemo(() => {
		const projector = options.projectMeta
		return items.map((item) => ({
			meta: projector ? projector(item.meta) : (item.meta as TMeta),
			item,
		}))
	}, [items, options.projectMeta])

	const hasFill = nodes.length > 0

	const render = useCallback(
		(fn: ExtensionSurfaceRender<TMeta>) => fn({ nodes, items: projectedItems, context, hasFill }),
		[nodes, projectedItems, context, hasFill],
	)

	return {
		nodes,
		items: projectedItems,
		context,
		hasFill,
		render,
	}
}
