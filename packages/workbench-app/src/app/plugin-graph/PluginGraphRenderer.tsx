/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- The spatial graph viewport is an ARIA application with equivalent keyboard pan and zoom controls. */
import {
	IconAlertTriangle,
	IconArrowsMaximize,
	IconPlugConnectedX,
	IconSearch,
	IconX,
	IconZoomIn,
	IconZoomOut,
} from '@tabler/icons-react'
import {
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type WheelEvent as ReactWheelEvent,
} from 'react'
import {
	PLUGIN_GRAPH_NODE_HEIGHT,
	PLUGIN_GRAPH_NODE_WIDTH,
	layoutPluginGraph,
} from './pluginGraphLayout'
import {
	describePluginGraphNode,
	type PluginGraphSelection,
	type PluginGraphVisualEdge,
	type PluginGraphVisualModel,
	type PluginGraphVisualNode,
} from './pluginGraphModel'

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2
const ZOOM_FACTOR = 1.16
const KEYBOARD_PAN_STEP = 48

type ViewportTransform = Readonly<{ x: number; y: number; zoom: number }>
type ViewportDrag = Readonly<{
	pointerId: number
	startX: number
	startY: number
	originX: number
	originY: number
	zoom: number
	moved: boolean
}>

export function PluginGraphRenderer({
	model,
	selection,
	onSelect,
}: {
	model: PluginGraphVisualModel
	selection: PluginGraphSelection | null
	onSelect: (selection: PluginGraphSelection | null) => void
}) {
	const layout = useMemo(() => layoutPluginGraph(model), [model])
	const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null)
	const [viewportSize, setViewportSize] = useState<Readonly<{
		width: number
		height: number
	}> | null>(null)
	const [viewMode, setViewMode] = useState<'fit' | 'manual'>('fit')
	const [manualTransform, setManualTransform] = useState<ViewportTransform>({
		x: 0,
		y: 0,
		zoom: 1,
	})
	const [isPanning, setIsPanning] = useState(false)
	const [unconnectedOpen, setUnconnectedOpen] = useState(false)
	const [unconnectedQuery, setUnconnectedQuery] = useState('')
	const nodeElements = useRef(new Map<string, HTMLButtonElement>())
	const drag = useRef<ViewportDrag | null>(null)
	const markerPrefix = useId().replaceAll(':', '')
	const fitTransform = useMemo<ViewportTransform>(() => {
		if (!viewportSize) return { x: 0, y: 0, zoom: 1 }
		const availableWidth = Math.max(viewportSize.width - 48, 1)
		const availableHeight = Math.max(viewportSize.height - 48, 1)
		const zoom = clamp(
			Math.min(availableWidth / layout.width, availableHeight / layout.height),
			MIN_ZOOM,
			1,
		)
		return Object.freeze({
			x: (viewportSize.width - layout.width * zoom) / 2,
			y: (viewportSize.height - layout.height * zoom) / 2,
			zoom,
		})
	}, [layout.height, layout.width, viewportSize])
	const transform = viewMode === 'fit' ? fitTransform : manualTransform
	const transformRef = useRef(transform)
	transformRef.current = transform
	const relationFocus = useMemo(() => {
		if (!selection) return null
		const nodeIds = new Set<string>()
		const edgeIds = new Set<string>()
		if (selection.kind === 'edge') {
			nodeIds.add(selection.edge.source)
			nodeIds.add(selection.edge.target)
			edgeIds.add(selection.edge.id)
		} else {
			if (!layout.positions.has(selection.node.id)) return null
			nodeIds.add(selection.node.id)
			for (const edge of [
				...(model.incomingById.get(selection.node.id) ?? []),
				...(model.outgoingById.get(selection.node.id) ?? []),
			]) {
				edgeIds.add(edge.id)
				nodeIds.add(edge.source)
				nodeIds.add(edge.target)
			}
		}
		return { nodeIds, edgeIds }
	}, [layout.positions, model.incomingById, model.outgoingById, selection])
	const componentById = useMemo(
		() => new Map(model.components.map((component) => [component.id, component] as const)),
		[model.components],
	)
	const unconnectedNodes = useMemo(() => {
		const query = unconnectedQuery.trim().toLocaleLowerCase()
		return [...model.isolatedNodes]
			.filter((node) => !query || model.searchTextById.get(node.id)?.includes(query))
			.sort(
				(first, second) =>
					describePluginGraphNode(first).priority - describePluginGraphNode(second).priority ||
					first.label.localeCompare(second.label),
			)
	}, [model.isolatedNodes, model.searchTextById, unconnectedQuery])

	useEffect(() => {
		setViewMode('fit')
	}, [model.topologyKey])

	useEffect(() => {
		if (selection) setUnconnectedOpen(false)
	}, [selection])

	useEffect(() => {
		if (model.isolatedNodes.length === 0) setUnconnectedOpen(false)
	}, [model.isolatedNodes.length])

	useEffect(() => {
		if (!viewportElement) return undefined
		const measure = () => {
			const { width, height } = viewportElement.getBoundingClientRect()
			if (width <= 0 || height <= 0) return
			setViewportSize((current) =>
				current?.width === width && current.height === height
					? current
					: Object.freeze({ width, height }),
			)
		}
		measure()
		if (typeof ResizeObserver === 'undefined') return undefined
		const observer = new ResizeObserver(measure)
		observer.observe(viewportElement)
		return () => observer.disconnect()
	}, [viewportElement])

	useEffect(() => {
		if (!selection) return
		if (
			selection.kind === 'node' &&
			model.isolatedNodes.some((node) => node.id === selection.node.id)
		) {
			const element = nodeElements.current.get(selection.node.id)
			if (element && typeof element.scrollIntoView === 'function') {
				element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
			}
			return
		}
		if (!viewportSize) return
		let point: Readonly<{ x: number; y: number }> | null = null
		if (selection.kind === 'node') {
			const position = layout.positions.get(selection.node.id)
			if (position) {
				point = {
					x: position.x + PLUGIN_GRAPH_NODE_WIDTH / 2,
					y: position.y + PLUGIN_GRAPH_NODE_HEIGHT / 2,
				}
			}
		} else {
			const geometry = layout.edges.get(selection.edge.id)
			if (geometry) point = { x: geometry.labelX, y: geometry.labelY }
		}
		if (!point) return
		const current = transformRef.current
		const screenX = current.x + point.x * current.zoom
		const screenY = current.y + point.y * current.zoom
		const visibleWidth =
			viewportSize.width >= 760 ? Math.max(viewportSize.width - 360, 280) : viewportSize.width
		const margin = 64
		if (
			screenX >= margin &&
			screenX <= visibleWidth - margin &&
			screenY >= margin &&
			screenY <= viewportSize.height - margin
		) {
			return
		}
		setManualTransform(
			Object.freeze({
				x: visibleWidth / 2 - point.x * current.zoom,
				y: viewportSize.height / 2 - point.y * current.zoom,
				zoom: current.zoom,
			}),
		)
		setViewMode('manual')
	}, [layout.edges, layout.positions, model.isolatedNodes, selection, viewportSize])

	const setManualView = (next: ViewportTransform) => {
		setManualTransform(Object.freeze(next))
		setViewMode('manual')
	}
	const zoomAt = (nextZoom: number, anchorX?: number, anchorY?: number) => {
		const current = transformRef.current
		const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
		const x = anchorX ?? (viewportSize?.width ?? 0) / 2
		const y = anchorY ?? (viewportSize?.height ?? 0) / 2
		const worldX = (x - current.x) / current.zoom
		const worldY = (y - current.y) / current.zoom
		setManualView({ x: x - worldX * zoom, y: y - worldY * zoom, zoom })
	}
	const selectedNodeId = selection?.kind === 'node' ? selection.node.id : null
	const selectedEdgeId = selection?.kind === 'edge' ? selection.edge.id : null
	const stageStyle = {
		'--plx-plugin-graph-width': `${layout.width}px`,
		'--plx-plugin-graph-height': `${layout.height}px`,
		transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.zoom})`,
	} as CSSProperties
	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.pointerType === 'mouse' && event.button !== 0) return
		if ((event.target as Element).closest('[data-graph-interactive]')) return
		event.preventDefault()
		event.currentTarget.focus({ preventScroll: true })
		if (typeof event.currentTarget.setPointerCapture === 'function') {
			event.currentTarget.setPointerCapture(event.pointerId)
		}
		const current = transformRef.current
		drag.current = Object.freeze({
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			originX: current.x,
			originY: current.y,
			zoom: current.zoom,
			moved: false,
		})
	}
	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const currentDrag = drag.current
		if (!currentDrag || currentDrag.pointerId !== event.pointerId) return
		const deltaX = event.clientX - currentDrag.startX
		const deltaY = event.clientY - currentDrag.startY
		const moved = currentDrag.moved || Math.hypot(deltaX, deltaY) >= 3
		drag.current = Object.freeze({ ...currentDrag, moved })
		if (!moved) return
		if (!isPanning) setIsPanning(true)
		setManualTransform(
			Object.freeze({
				x: currentDrag.originX + deltaX,
				y: currentDrag.originY + deltaY,
				zoom: currentDrag.zoom,
			}),
		)
		setViewMode('manual')
	}
	const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
		const currentDrag = drag.current
		if (!currentDrag || currentDrag.pointerId !== event.pointerId) return
		if (typeof event.currentTarget.releasePointerCapture === 'function') {
			if (
				typeof event.currentTarget.hasPointerCapture !== 'function' ||
				event.currentTarget.hasPointerCapture(event.pointerId)
			) {
				event.currentTarget.releasePointerCapture(event.pointerId)
			}
		}
		drag.current = null
		setIsPanning(false)
		if (!currentDrag.moved) onSelect(null)
	}
	const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
		event.preventDefault()
		const bounds = event.currentTarget.getBoundingClientRect()
		const factor = Math.exp(-event.deltaY * 0.0015)
		zoomAt(
			transformRef.current.zoom * factor,
			event.clientX - bounds.left,
			event.clientY - bounds.top,
		)
	}
	const handleViewportKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget) return
		const current = transformRef.current
		if (event.key === 'Escape') {
			event.preventDefault()
			onSelect(null)
			return
		}
		if (event.key === '0') {
			event.preventDefault()
			setViewMode('fit')
			return
		}
		if (event.key === '+' || event.key === '=') {
			event.preventDefault()
			zoomAt(current.zoom * ZOOM_FACTOR)
			return
		}
		if (event.key === '-') {
			event.preventDefault()
			zoomAt(current.zoom / ZOOM_FACTOR)
			return
		}
		const offset =
			event.key === 'ArrowLeft'
				? { x: KEYBOARD_PAN_STEP, y: 0 }
				: event.key === 'ArrowRight'
					? { x: -KEYBOARD_PAN_STEP, y: 0 }
					: event.key === 'ArrowUp'
						? { x: 0, y: KEYBOARD_PAN_STEP }
						: event.key === 'ArrowDown'
							? { x: 0, y: -KEYBOARD_PAN_STEP }
							: null
		if (!offset) return
		event.preventDefault()
		setManualView({ x: current.x + offset.x, y: current.y + offset.y, zoom: current.zoom })
	}

	return (
		<div className="plx-pluginGraphRenderer">
			<section className="plx-pluginGraphRelations" aria-labelledby="plugin-graph-relations-title">
				<div className="plx-pluginGraphRelations__header">
					<div>
						<strong id="plugin-graph-relations-title">依赖关系</strong>
						<span>
							提供方 → 使用方 · {model.connectedNodes.length} 个节点 · {model.edges.length} 条关系
						</span>
					</div>
					<div className="plx-pluginGraphHeaderActions">
						<div className="plx-pluginGraphLegend" aria-label="依赖关系图例">
							<span data-mode="required">
								<i />
								必须依赖
							</span>
							<span data-mode="optional">
								<i />
								可选集成
							</span>
						</div>
						{model.isolatedNodes.length > 0 ? (
							<button
								type="button"
								className="plx-pluginGraphUnconnectedToggle"
								data-active={unconnectedOpen ? 'true' : 'false'}
								aria-expanded={unconnectedOpen}
								onClick={() => {
									const next = !unconnectedOpen
									if (next) {
										setUnconnectedQuery('')
										onSelect(null)
									}
									setUnconnectedOpen(next)
								}}
							>
								<IconPlugConnectedX size={15} />
								<span>独立节点 {model.isolatedNodes.length}</span>
							</button>
						) : null}
						{model.edges.length > 0 ? (
							<div className="plx-pluginGraphZoom" aria-label="关系图缩放">
								<button
									type="button"
									onClick={() => zoomAt(transform.zoom / ZOOM_FACTOR)}
									disabled={transform.zoom <= MIN_ZOOM}
									aria-label="缩小关系图"
								>
									<IconZoomOut size={15} />
								</button>
								<span aria-live="polite">{Math.round(transform.zoom * 100)}%</span>
								<button
									type="button"
									onClick={() => zoomAt(transform.zoom * ZOOM_FACTOR)}
									disabled={transform.zoom >= MAX_ZOOM}
									aria-label="放大关系图"
								>
									<IconZoomIn size={15} />
								</button>
								<button
									type="button"
									onClick={() => setViewMode('fit')}
									data-active={viewMode === 'fit' ? 'true' : 'false'}
									aria-label="适应关系图"
								>
									<IconArrowsMaximize size={15} />
								</button>
							</div>
						) : null}
					</div>
				</div>

				{model.edges.length === 0 ? (
					<div className="plx-pluginGraphRelations__empty" role="status">
						<strong>当前筛选下没有依赖关系</strong>
						<span>可以查看独立节点，或切换到“声明关系”。</span>
					</div>
				) : (
					<div
						ref={setViewportElement}
						className="plx-pluginGraphViewport"
						role="application"
						tabIndex={0}
						data-panning={isPanning ? 'true' : 'false'}
						aria-label="Plugin 依赖图，可拖动平移、滚轮缩放，方向键平移，0 恢复完整视图"
						onPointerDown={handlePointerDown}
						onPointerMove={handlePointerMove}
						onPointerUp={finishPointer}
						onPointerCancel={finishPointer}
						onWheel={handleWheel}
						onKeyDown={handleViewportKey}
					>
						<div className="plx-pluginGraphStage" style={stageStyle}>
							{layout.components.map((component, index) => {
								const visualComponent = componentById.get(component.id)
								const muted = Boolean(
									relationFocus &&
									!visualComponent?.nodes.some((node) => relationFocus.nodeIds.has(node.id)),
								)
								return (
									<div
										key={component.id}
										className="plx-pluginGraphComponent"
										data-muted={muted ? 'true' : 'false'}
										style={{
											left: component.x,
											top: component.y,
											width: component.width,
											height: component.height,
										}}
									>
										{model.components.length > 1 ? (
											<span>
												关系组 {index + 1} · {component.nodeCount} 个节点 · {component.edgeCount}{' '}
												条关系
											</span>
										) : null}
									</div>
								)
							})}
							<svg
								className="plx-pluginGraphEdges"
								width={layout.width}
								height={layout.height}
								aria-label="Plugin dependency relations"
							>
								<defs>
									<marker
										id={`${markerPrefix}-arrow`}
										viewBox="0 0 10 10"
										refX="9"
										refY="5"
										markerWidth="7"
										markerHeight="7"
										orient="auto-start-reverse"
									>
										<path d="M 0 0 L 10 5 L 0 10 z" />
									</marker>
									<marker
										id={`${markerPrefix}-arrow-selected`}
										viewBox="0 0 10 10"
										refX="9"
										refY="5"
										markerWidth="7"
										markerHeight="7"
										orient="auto-start-reverse"
									>
										<path d="M 0 0 L 10 5 L 0 10 z" />
									</marker>
								</defs>
								{model.edges.map((edge) => {
									const geometry = layout.edges.get(edge.id)
									if (!geometry) return null
									const selected = edge.id === selectedEdgeId
									const label = pluginGraphEdgeLabel(edge)
									return (
										<g
											key={edge.id}
											className="plx-pluginGraphEdge"
											data-effective={edge.effective ? 'true' : 'false'}
											data-mode={edge.mode}
											data-selected={selected ? 'true' : 'false'}
											data-muted={
												relationFocus && !relationFocus.edgeIds.has(edge.id) ? 'true' : 'false'
											}
											data-unresolved={
												edge.edge.resolution.state === 'unresolved' ? 'true' : 'false'
											}
											data-graph-interactive
											role="button"
											tabIndex={0}
											aria-label={pluginGraphEdgeAriaLabel(model, edge)}
											onClick={(event) => {
												event.stopPropagation()
												onSelect({ kind: 'edge', edge })
											}}
											onKeyDown={(event) =>
												handleSelectionKey(event, () => onSelect({ kind: 'edge', edge }), onSelect)
											}
										>
											<title>{pluginGraphEdgeAriaLabel(model, edge)}</title>
											<path className="plx-pluginGraphEdge__hit" d={geometry.path} />
											<path
												className="plx-pluginGraphEdge__line"
												d={geometry.path}
												markerEnd={`url(#${markerPrefix}-${selected ? 'arrow-selected' : 'arrow'})`}
											/>
											<rect
												className="plx-pluginGraphEdge__labelBackground"
												x={geometry.labelX - geometry.labelWidth / 2}
												y={geometry.labelY - 11}
												width={geometry.labelWidth}
												height={22}
												rx={11}
											/>
											<text
												className="plx-pluginGraphEdge__label"
												x={geometry.labelX}
												y={geometry.labelY}
												dy="0.35em"
											>
												{label}
											</text>
										</g>
									)
								})}
							</svg>
							{model.connectedNodes.map((node) => {
								const position = layout.positions.get(node.id)
								if (!position) return null
								return (
									<PluginGraphNodeButton
										key={node.id}
										visual={node}
										selected={node.id === selectedNodeId}
										muted={Boolean(relationFocus && !relationFocus.nodeIds.has(node.id))}
										style={{ left: position.x, top: position.y }}
										register={(element) => registerElement(nodeElements.current, node.id, element)}
										onSelect={() => onSelect({ kind: 'node', node })}
										onClear={() => onSelect(null)}
									/>
								)
							})}
						</div>
					</div>
				)}
			</section>

			{unconnectedOpen ? (
				<aside className="plx-pluginGraphUnconnectedPanel" aria-label="依赖图中的独立 Plugin">
					<div className="plx-pluginGraphUnconnectedPanel__heading">
						<div>
							<strong>独立节点</strong>
							<span>当前筛选下没有可见关系，不代表 Plugin 无效</span>
						</div>
						<button
							type="button"
							onClick={() => setUnconnectedOpen(false)}
							aria-label="关闭独立节点列表"
						>
							<IconX size={16} />
						</button>
					</div>
					<label className="plx-pluginGraphUnconnectedPanel__search">
						<IconSearch size={14} aria-hidden />
						<input
							type="search"
							value={unconnectedQuery}
							onChange={(event) => setUnconnectedQuery(event.currentTarget.value)}
							placeholder="筛选名称或标准引用"
							aria-label="筛选独立 Plugin"
						/>
					</label>
					<div className="plx-pluginGraphUnconnectedPanel__list">
						{unconnectedNodes.length > 0 ? (
							unconnectedNodes.map((node) => (
								<PluginGraphNodeButton
									key={node.id}
									visual={node}
									selected={node.id === selectedNodeId}
									compact
									register={(element) => registerElement(nodeElements.current, node.id, element)}
									onSelect={() => {
										setUnconnectedOpen(false)
										onSelect({ kind: 'node', node })
									}}
									onClear={() => onSelect(null)}
								/>
							))
						) : (
							<div className="plx-pluginGraphUnconnectedPanel__empty">没有匹配的 Plugin</div>
						)}
					</div>
				</aside>
			) : null}
		</div>
	)
}

function PluginGraphNodeButton({
	visual,
	selected,
	compact = false,
	muted = false,
	style,
	register,
	onSelect,
	onClear,
}: {
	visual: PluginGraphVisualNode
	selected: boolean
	compact?: boolean
	muted?: boolean
	style?: CSSProperties
	register: (element: HTMLButtonElement | null) => void
	onSelect: () => void
	onClear: () => void
}) {
	const status = visual.kind === 'plugin' ? visual.node.status : null
	const hasIssue = Boolean(status?.issues.length)
	const presentation = describePluginGraphNode(visual)
	return (
		<button
			ref={register}
			type="button"
			className="plx-pluginGraphNode"
			style={style}
			data-compact={compact ? 'true' : 'false'}
			data-effective={visual.effective ? 'true' : 'false'}
			data-has-issue={hasIssue ? 'true' : 'false'}
			data-kind={visual.kind}
			data-selected={selected ? 'true' : 'false'}
			data-muted={muted ? 'true' : 'false'}
			data-state={presentation.state}
			data-graph-interactive
			aria-pressed={selected}
			aria-label={`${visual.label}，${visual.kind === 'plugin' ? 'Plugin 节点' : '占位节点'}，${presentation.stateLabel}，${visual.effective ? '当前有效图' : '仅声明'}`}
			onClick={onSelect}
			onKeyDown={(event) => {
				if (event.key !== 'Escape') return
				event.preventDefault()
				event.stopPropagation()
				onClear()
			}}
		>
			<span className="plx-pluginGraphNode__heading">
				<span className="plx-pluginGraphNode__label">{visual.label}</span>
				<span className="plx-pluginGraphNode__icons">
					{hasIssue ? <IconAlertTriangle aria-label="存在协调问题" size={15} /> : null}
					{visual.kind !== 'plugin' ? <IconPlugConnectedX aria-hidden size={15} /> : null}
				</span>
			</span>
			<span className="plx-pluginGraphNode__reference" title={visual.reference}>
				{visual.qualifier ?? visual.reference}
			</span>
			<span className="plx-pluginGraphNode__state">
				<span>
					<i aria-hidden />
					{presentation.stateLabel}
				</span>
				{visual.kind === 'plugin' && !compact && presentation.policyLabel ? (
					<span>{visual.effective ? presentation.policyLabel : '仅声明'}</span>
				) : null}
			</span>
		</button>
	)
}

function pluginGraphEdgeLabel(edge: PluginGraphVisualEdge): string {
	if (edge.edge.resolution.state === 'unresolved') return '未解析'
	return edge.mode === 'required' ? '必须' : '可选'
}

function pluginGraphEdgeAriaLabel(
	model: PluginGraphVisualModel,
	edge: PluginGraphVisualEdge,
): string {
	const provider = model.byId.get(edge.source)?.label ?? 'Unknown provider'
	const consumer = model.byId.get(edge.target)?.label ?? 'Unknown consumer'
	return `${provider} 到 ${consumer}，${edge.mode === 'required' ? '必须依赖' : '可选集成'}，${edge.effective ? '当前有效图' : '仅声明'}`
}

function handleSelectionKey(
	event: ReactKeyboardEvent,
	onSelect: () => void,
	onClear: (selection: null) => void,
): void {
	if (event.key === 'Escape') {
		event.preventDefault()
		event.stopPropagation()
		onClear(null)
		return
	}
	if (event.key !== 'Enter' && event.key !== ' ') return
	event.preventDefault()
	event.stopPropagation()
	onSelect()
}

function registerElement<T extends Element>(
	index: Map<string, T>,
	id: string,
	element: T | null,
): void {
	if (element) index.set(id, element)
	else index.delete(id)
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value))
}
