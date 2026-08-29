import { Graph, layout } from '@dagrejs/dagre'
import type {
	PluginGraphComponent,
	PluginGraphVisualEdge,
	PluginGraphVisualModel,
} from './pluginGraphModel'

export const PLUGIN_GRAPH_NODE_WIDTH = 220
export const PLUGIN_GRAPH_NODE_HEIGHT = 84

export type PluginGraphNodePosition = Readonly<{ x: number; y: number }>
export type PluginGraphEdgeGeometry = Readonly<{
	path: string
	labelX: number
	labelY: number
	labelWidth: number
}>
export type PluginGraphComponentGeometry = Readonly<{
	id: string
	x: number
	y: number
	width: number
	height: number
	nodeCount: number
	edgeCount: number
}>
export type PluginGraphLayout = Readonly<{
	topologyKey: string
	positions: ReadonlyMap<string, PluginGraphNodePosition>
	edges: ReadonlyMap<string, PluginGraphEdgeGeometry>
	components: readonly PluginGraphComponentGeometry[]
	width: number
	height: number
}>

type Point = Readonly<{ x: number; y: number }>
type LocalComponentLayout = Readonly<{
	component: PluginGraphComponent
	positions: ReadonlyMap<string, PluginGraphNodePosition>
	edges: ReadonlyMap<string, PluginGraphEdgeGeometry>
	width: number
	height: number
}>
type ComponentPlacement = Readonly<{
	local: LocalComponentLayout
	x: number
	y: number
}>

const MAX_LAYOUT_CACHE_ENTRIES = 32
const OUTER_PADDING = 24
const COMPONENT_GAP = 28
const TARGET_CANVAS_ASPECT_RATIO = 1.65
const layoutCache = new Map<string, PluginGraphLayout>()

export function layoutPluginGraph(model: PluginGraphVisualModel): PluginGraphLayout {
	const cached = layoutCache.get(model.topologyKey)
	if (cached) return cached

	const localLayouts = model.components.map(layoutComponent)
	const positions = new Map<string, PluginGraphNodePosition>()
	const edges = new Map<string, PluginGraphEdgeGeometry>()
	const components: PluginGraphComponentGeometry[] = []
	const placements = packComponents(localLayouts)
	let contentRight = OUTER_PADDING
	let contentBottom = OUTER_PADDING

	for (const { local, x, y } of placements) {
		for (const [id, position] of local.positions) {
			positions.set(id, Object.freeze({ x: position.x + x, y: position.y + y }))
		}
		for (const [id, geometry] of local.edges) {
			edges.set(
				id,
				Object.freeze({
					path: offsetPath(geometry.path, x, y),
					labelX: geometry.labelX + x,
					labelY: geometry.labelY + y,
					labelWidth: geometry.labelWidth,
				}),
			)
		}
		components.push(
			Object.freeze({
				id: local.component.id,
				x,
				y,
				width: local.width,
				height: local.height,
				nodeCount: local.component.nodes.length,
				edgeCount: local.component.edges.length,
			}),
		)

		contentRight = Math.max(contentRight, x + local.width)
		contentBottom = Math.max(contentBottom, y + local.height)
	}

	const result = Object.freeze({
		topologyKey: model.topologyKey,
		positions,
		edges,
		components: Object.freeze(components),
		width: Math.max(contentRight + OUTER_PADDING, 360),
		height: Math.max(contentBottom + OUTER_PADDING, 220),
	})
	layoutCache.set(model.topologyKey, result)
	if (layoutCache.size > MAX_LAYOUT_CACHE_ENTRIES) {
		const oldest = layoutCache.keys().next().value
		if (oldest !== undefined) layoutCache.delete(oldest)
	}
	return result
}

function packComponents(
	localLayouts: readonly LocalComponentLayout[],
): readonly ComponentPlacement[] {
	if (localLayouts.length === 0) return []
	const ordered = [...localLayouts].sort(
		(first, second) =>
			second.component.nodes.length - first.component.nodes.length ||
			second.component.edges.length - first.component.edges.length ||
			second.width * second.height - first.width * first.height ||
			first.component.id.localeCompare(second.component.id),
	)
	const columnCount = suggestedColumnCount(ordered)
	const columns = Array.from({ length: columnCount }, () => ({
		items: [] as Array<{ local: LocalComponentLayout; y: number }>,
		height: 0,
		width: 0,
	}))

	for (const local of ordered) {
		let columnIndex = 0
		for (let index = 1; index < columns.length; index += 1) {
			if (columns[index].height < columns[columnIndex].height) columnIndex = index
		}
		const column = columns[columnIndex]
		const y = column.height === 0 ? OUTER_PADDING : column.height + COMPONENT_GAP
		column.items.push({ local, y })
		column.height = y + local.height
		column.width = Math.max(column.width, local.width)
	}

	const placements: ComponentPlacement[] = []
	let x = OUTER_PADDING
	for (const column of columns) {
		for (const item of column.items) {
			placements.push(Object.freeze({ local: item.local, x, y: item.y }))
		}
		x += column.width + COMPONENT_GAP
	}
	return Object.freeze(placements)
}

function suggestedColumnCount(localLayouts: readonly LocalComponentLayout[]): number {
	if (localLayouts.length <= 1) return localLayouts.length
	const averageWidth =
		localLayouts.reduce((total, local) => total + local.width, 0) / localLayouts.length
	const averageHeight =
		localLayouts.reduce((total, local) => total + local.height, 0) / localLayouts.length
	const averageAspect = averageWidth / Math.max(averageHeight, 1)
	const balanced = Math.ceil(
		Math.sqrt((localLayouts.length * TARGET_CANVAS_ASPECT_RATIO) / averageAspect),
	)
	return Math.min(localLayouts.length, Math.max(2, balanced))
}

function layoutComponent(component: PluginGraphComponent): LocalComponentLayout {
	const graph = new Graph({ directed: true, multigraph: true })
	graph.setGraph({
		rankdir: 'LR',
		ranker: 'network-simplex',
		acyclicer: 'greedy',
		nodesep: 36,
		edgesep: 14,
		ranksep: 96,
		marginx: 32,
		marginy: 52,
	})
	graph.setDefaultEdgeLabel(() => ({}))
	for (const node of component.nodes) {
		graph.setNode(node.id, {
			width: PLUGIN_GRAPH_NODE_WIDTH,
			height: PLUGIN_GRAPH_NODE_HEIGHT,
		})
	}
	for (const edge of component.edges) {
		graph.setEdge(
			edge.source,
			edge.target,
			{ width: edgeLabelWidth(edge), height: 22, labelpos: 'c' },
			edge.id,
		)
	}

	layout(graph)
	const positions = new Map<string, PluginGraphNodePosition>()
	for (const node of component.nodes) {
		const positioned = graph.node(node.id) as { x?: number; y?: number } | undefined
		const centerX = positioned?.x ?? PLUGIN_GRAPH_NODE_WIDTH / 2
		const centerY = positioned?.y ?? PLUGIN_GRAPH_NODE_HEIGHT / 2
		positions.set(
			node.id,
			Object.freeze({
				x: centerX - PLUGIN_GRAPH_NODE_WIDTH / 2,
				y: centerY - PLUGIN_GRAPH_NODE_HEIGHT / 2,
			}),
		)
	}

	const edges = new Map<string, PluginGraphEdgeGeometry>()
	for (const edge of component.edges) {
		const positioned = graph.edge({ v: edge.source, w: edge.target, name: edge.id }) as
			| { points?: Point[]; x?: number; y?: number }
			| undefined
		const points = positioned?.points ?? fallbackEdgePoints(edge, positions)
		const midpoint = pointAtHalfLength(points)
		edges.set(
			edge.id,
			Object.freeze({
				path: roundedPath(points),
				labelX: positioned?.x ?? midpoint.x,
				labelY: positioned?.y ?? midpoint.y,
				labelWidth: edgeLabelWidth(edge),
			}),
		)
	}

	const graphLabel = graph.graph() as { width?: number; height?: number }
	return Object.freeze({
		component,
		positions,
		edges,
		width: Math.max(graphLabel.width ?? 0, PLUGIN_GRAPH_NODE_WIDTH + 64),
		height: Math.max(graphLabel.height ?? 0, PLUGIN_GRAPH_NODE_HEIGHT + 104),
	})
}

function edgeLabelWidth(edge: PluginGraphVisualEdge): number {
	if (edge.edge.resolution.state === 'unresolved') return 104
	return edge.mode === 'required' ? 72 : 70
}

function fallbackEdgePoints(
	edge: PluginGraphVisualEdge,
	positions: ReadonlyMap<string, PluginGraphNodePosition>,
): Point[] {
	const source = positions.get(edge.source) ?? { x: 0, y: 0 }
	const target = positions.get(edge.target) ?? { x: PLUGIN_GRAPH_NODE_WIDTH + 80, y: 0 }
	return [
		{ x: source.x + PLUGIN_GRAPH_NODE_WIDTH, y: source.y + PLUGIN_GRAPH_NODE_HEIGHT / 2 },
		{ x: target.x, y: target.y + PLUGIN_GRAPH_NODE_HEIGHT / 2 },
	]
}

function roundedPath(points: readonly Point[]): string {
	if (points.length === 0) return ''
	if (points.length === 1) return `M ${coordinate(points[0].x)} ${coordinate(points[0].y)}`
	let value = `M ${coordinate(points[0].x)} ${coordinate(points[0].y)}`
	for (let index = 1; index < points.length - 1; index += 1) {
		const previous = points[index - 1]
		const current = points[index]
		const next = points[index + 1]
		const before = moveTowards(current, previous, cornerRadius(previous, current, next))
		const after = moveTowards(current, next, cornerRadius(previous, current, next))
		value += ` L ${coordinate(before.x)} ${coordinate(before.y)}`
		value += ` Q ${coordinate(current.x)} ${coordinate(current.y)} ${coordinate(after.x)} ${coordinate(after.y)}`
	}
	const last = points[points.length - 1]
	return `${value} L ${coordinate(last.x)} ${coordinate(last.y)}`
}

function cornerRadius(previous: Point, current: Point, next: Point): number {
	return Math.min(10, distance(previous, current) / 2, distance(current, next) / 2)
}

function moveTowards(from: Point, to: Point, amount: number): Point {
	const length = distance(from, to)
	if (length === 0) return from
	return {
		x: from.x + ((to.x - from.x) / length) * amount,
		y: from.y + ((to.y - from.y) / length) * amount,
	}
}

function distance(first: Point, second: Point): number {
	return Math.hypot(second.x - first.x, second.y - first.y)
}

function pointAtHalfLength(points: readonly Point[]): Point {
	if (points.length === 0) return { x: 0, y: 0 }
	let total = 0
	for (let index = 1; index < points.length; index += 1) {
		total += distance(points[index - 1], points[index])
	}
	let remaining = total / 2
	for (let index = 1; index < points.length; index += 1) {
		const segment = distance(points[index - 1], points[index])
		if (remaining <= segment) return moveTowards(points[index - 1], points[index], remaining)
		remaining -= segment
	}
	return points[points.length - 1]
}

function offsetPath(path: string, x: number, y: number): string {
	if (x === 0 && y === 0) return path
	return path.replaceAll(
		/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
		(_, px, py) => `${coordinate(Number(px) + x)} ${coordinate(Number(py) + y)}`,
	)
}

function coordinate(value: number): string {
	return Number(value.toFixed(2)).toString()
}

export function clearPluginGraphLayoutCacheForTests(): void {
	layoutCache.clear()
}
