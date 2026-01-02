import { useCallback, useMemo, type ReactNode } from 'react'
import { useExtensions } from '../registry'
import type { ExtensionPoint, ExtensionItem, ExtensionPointCtx } from '../types'

export interface ExtensionSurfaceOptions<
	P extends ExtensionPoint,
	TMeta = ExtensionItem<P>['meta'],
> {
	projectMeta?: (meta: ExtensionItem<P>['meta']) => TMeta
}

export interface ExtensionSurfaceRenderPayload<P extends ExtensionPoint, TMeta> {
	nodes: ReactNode[]
	items: Array<{ meta: TMeta; item: ExtensionItem<P> }>
	context: ExtensionPointCtx<P> | null
	hasFill: boolean
}

export type ExtensionSurfaceRender<P extends ExtensionPoint, TMeta> = (
	payload: ExtensionSurfaceRenderPayload<P, TMeta>,
) => ReactNode

export interface ExtensionSurfaceResult<P extends ExtensionPoint, TMeta> {
	nodes: ReactNode[]
	items: Array<{ meta: TMeta; item: ExtensionItem<P> }>
	context: ExtensionPointCtx<P> | null
	hasFill: boolean
	render: (fn: ExtensionSurfaceRender<P, TMeta>) => ReactNode
}

export function useExtensionSurface<P extends ExtensionPoint, TMeta = ExtensionItem<P>['meta']>(
	point: P,
	options: ExtensionSurfaceOptions<P, TMeta> = {},
): ExtensionSurfaceResult<P, TMeta> {
	const { items, nodes, context } = useExtensions(point)

	const projectedItems = useMemo(() => {
		const projector = options.projectMeta
		return items.map((item) => ({
			meta: projector ? projector(item.meta) : (item.meta as TMeta),
			item,
		}))
	}, [items, options.projectMeta])

	const hasFill = nodes.length > 0

	const render = useCallback(
		(fn: ExtensionSurfaceRender<P, TMeta>) =>
			fn({ nodes, items: projectedItems, context, hasFill }),
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
