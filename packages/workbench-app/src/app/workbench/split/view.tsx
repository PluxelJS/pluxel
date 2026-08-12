import {
	Pane,
	SplitView,
	type PaneSizeValue,
	type SplitViewHandle as WorksplitHandle,
	type SplitViewLayoutEvent,
} from '@worksplit/react'
import '@worksplit/react/style.css'
import {
	forwardRef,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
	type RefObject,
} from 'react'

const PANEL_STYLE = {
	display: 'flex',
	flexDirection: 'column',
	height: '100%',
	minHeight: 0,
	minWidth: 0,
} satisfies CSSProperties

export type SplitViewLayout = Record<string, number>

export type SplitViewHandle = {
	getLayout: () => SplitViewLayout
	setLayout: (layout: SplitViewLayout) => void
	resizePane: (id: string, size: number) => void
	reset: () => void
}

export type SplitViewPane = {
	id: string
	children: ReactNode
	defaultSize?: PaneSizeValue
	defaultSizePercent?: number
	minSize?: number
	minSizePercent?: number
	maxSize?: number
	snap?: boolean
	visible?: boolean
	onVisibleChange?: (visible: boolean) => void
	collapsedContent?: ReactNode | ((restore: () => void) => ReactNode)
	className?: string
	style?: CSSProperties
	ariaHidden?: boolean
	inert?: boolean
}

export type WorkbenchSplitViewProps = {
	className?: string
	layout: SplitViewLayout
	id: string
	onLayoutCommit?: (layout: SplitViewLayout) => void
	orientation: 'horizontal' | 'vertical'
	panes: readonly SplitViewPane[]
	separatorClassName?: string
}

function joinClasses(...values: Array<string | undefined>) {
	return values.filter(Boolean).join(' ')
}

export function splitPercentLayoutFromSizeById(
	panes: readonly SplitViewPane[],
	sizeById: Readonly<Record<string, number>>,
	axisSize: number,
	currentLayout: SplitViewLayout,
) {
	if (axisSize <= 0) return { ...currentLayout }
	return panes.reduce<SplitViewLayout>(
		(acc, pane) => {
			const size = sizeById[pane.id]
			if (typeof size === 'number' && Number.isFinite(size) && size > 0.5) {
				acc[pane.id] = (size / axisSize) * 100
			}
			return acc
		},
		{ ...currentLayout },
	)
}

function toPixelSizes(paneIds: readonly string[], layout: SplitViewLayout, axisSize: number) {
	return Object.fromEntries(
		paneIds.flatMap((paneId) => {
			const size = layout[paneId]
			return typeof size === 'number' && Number.isFinite(size) && size >= 0
				? [[paneId, (size / 100) * axisSize]]
				: []
		}),
	)
}

function createLayoutSignature(
	paneIds: readonly string[],
	layout: SplitViewLayout,
	axisSize: number,
) {
	return paneIds.map((paneId) => `${paneId}:${layout[paneId] ?? ''}`).join('|') + `@${axisSize}`
}

function resolveAxisSize(host: HTMLDivElement, orientation: 'horizontal' | 'vertical') {
	return orientation === 'vertical' ? host.clientHeight : host.clientWidth
}

function useObservedAxisSize(
	hostRef: RefObject<HTMLDivElement | null>,
	orientation: 'horizontal' | 'vertical',
) {
	const axisSizeRef = useRef(0)
	const [axisSize, setAxisSize] = useState(0)

	useLayoutEffect(() => {
		const host = hostRef.current
		if (!host) return undefined
		const readAxisSize = () => {
			const nextSize = resolveAxisSize(host, orientation)
			axisSizeRef.current = nextSize
			setAxisSize((current) => (Math.abs(current - nextSize) < 0.5 ? current : nextSize))
		}
		readAxisSize()
		if (typeof ResizeObserver === 'undefined') return undefined
		const observer = new ResizeObserver(readAxisSize)
		observer.observe(host)
		return () => observer.disconnect()
	}, [hostRef, orientation])

	return { axisSize, axisSizeRef }
}

/** Private adapter: this is the only Pluxel application module that knows Worksplit's protocol. */
export const WorkbenchSplitView = forwardRef<SplitViewHandle, WorkbenchSplitViewProps>(
	(
		{
			className,
			layout,
			id,
			onLayoutCommit,
			orientation,
			panes,
			separatorClassName = 'plx-workbench__resizeHandle',
		},
		ref,
	) => {
		const splitRef = useRef<WorksplitHandle | null>(null)
		const hostRef = useRef<HTMLDivElement | null>(null)
		const layoutRef = useRef<SplitViewLayout>({ ...layout })
		const syncedLayoutSignatureRef = useRef('')
		const { axisSize, axisSizeRef } = useObservedAxisSize(hostRef, orientation)
		const paneIds = useMemo(() => panes.map((pane) => pane.id), [panes])
		const defaultSizeById = useMemo(
			() => (axisSize > 0 ? toPixelSizes(paneIds, layout, axisSize) : undefined),
			[axisSize, layout, paneIds],
		)

		useLayoutEffect(() => {
			layoutRef.current = { ...layout }
			const currentAxisSize = axisSizeRef.current || axisSize
			if (currentAxisSize <= 0 || Object.keys(layout).length === 0) return
			const signature = createLayoutSignature(paneIds, layout, currentAxisSize)
			if (syncedLayoutSignatureRef.current === signature) return
			syncedLayoutSignatureRef.current = signature
			splitRef.current?.setPaneSizes(toPixelSizes(paneIds, layout, currentAxisSize))
		}, [axisSize, axisSizeRef, layout, paneIds])

		useImperativeHandle(
			ref,
			() => ({
				getLayout: () => ({ ...layoutRef.current }),
				setLayout: (nextLayout) => {
					layoutRef.current = { ...nextLayout }
					if (axisSizeRef.current > 0) {
						splitRef.current?.setPaneSizes(toPixelSizes(paneIds, nextLayout, axisSizeRef.current))
					}
				},
				resizePane: (paneId, size) => splitRef.current?.resizePane(paneId, size),
				reset: () => splitRef.current?.reset(),
			}),
			[axisSizeRef, paneIds],
		)

		const handleLayoutCommit = useMemo(() => {
			if (!onLayoutCommit) return undefined
			return ({ phase, reason, sizeById }: SplitViewLayoutEvent) => {
				if (phase !== 'commit' || (reason !== 'pointer' && reason !== 'keyboard')) return
				const nextLayout = splitPercentLayoutFromSizeById(
					panes,
					sizeById,
					axisSizeRef.current || axisSize,
					layoutRef.current,
				)
				layoutRef.current = nextLayout
				onLayoutCommit(nextLayout)
			}
		}, [axisSize, axisSizeRef, onLayoutCommit, panes])

		return (
			<div
				ref={hostRef}
				className={joinClasses('plx-workbenchSplitView', className, separatorClassName)}
				style={PANEL_STYLE}
			>
				<SplitView
					defaultSizeById={defaultSizeById}
					id={id}
					onLayout={handleLayoutCommit}
					proportionalResize
					ref={splitRef}
					onPaneVisibilityChange={({ id: paneId, visible }) => {
						panes.find((pane) => pane.id === paneId)?.onVisibleChange?.(visible)
					}}
					orientation={orientation}
					renderCollapsedPane={({ id: paneId }) => {
						const content = panes.find((pane) => pane.id === paneId)?.collapsedContent
						return typeof content === 'function'
							? content(() => splitRef.current?.expandPane(paneId))
							: content
					}}
				>
					{panes.map((pane) => (
						<Pane
							key={pane.id}
							id={pane.id}
							className={pane.className}
							style={pane.style}
							aria-hidden={pane.ariaHidden || undefined}
							inert={pane.inert || undefined}
							minSize={
								pane.minSizePercent !== undefined && axisSize > 0
									? (axisSize * pane.minSizePercent) / 100
									: pane.minSize
							}
							maxSize={pane.maxSize}
							defaultSize={
								pane.defaultSizePercent !== undefined
									? (`${pane.defaultSizePercent}%` as `${number}%`)
									: pane.defaultSize
							}
							snap={pane.snap}
							visible={pane.visible}
						>
							<div style={PANEL_STYLE}>{pane.children}</div>
						</Pane>
					))}
				</SplitView>
			</div>
		)
	},
)

WorkbenchSplitView.displayName = 'WorkbenchSplitView'
