import { useCallback, useMemo, type ReactNode } from 'react'
import type { ExtensionPoint, ExtensionItem, ExtensionPointCtx } from '@pluxel/runtime/web'
import { useExtensions } from '../internal/registry'

export interface ExtensionSurfaceOptions<
	P extends ExtensionPoint,
	TMeta = ExtensionItem<P>['meta'],
> {
	projectMeta?: (meta: ExtensionItem<P>['meta']) => TMeta
	renderNodes?: boolean
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
	const { items, nodes, context } = useExtensions(point, { renderNodes: options.renderNodes })

	const projectedItems = useMemo(() => {
		const projector = options.projectMeta
		return items.map((item) => ({
			meta: projector ? projector(item.meta) : (item.meta as TMeta),
			item,
		}))
	}, [items, options.projectMeta])

	const hasFill = items.length > 0

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
