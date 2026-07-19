import {
	Pane,
	SplitView,
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
	type RefObject,
	type ReactNode,
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
}

export type SplitViewPane = {
	id: string
	defaultSize: number
	minSize: number
	children: ReactNode
	snap?: boolean
	visible?: boolean
	onVisibleChange?: (visible: boolean) => void
}

export type WorkbenchSplitViewProps = {
	className?: string
	layout: SplitViewLayout
	id: string
	onLayoutCommit?: (layout: SplitViewLayout) => void
	orientation: 'horizontal' | 'vertical'
	primary: SplitViewPane
	secondary?: SplitViewPane
	separatorClassName?: string
}

function toPanelSize(size: number): `${number}%` {
	return `${size}%` as `${number}%`
}

function joinClasses(...values: Array<string | undefined>) {
	return values.filter(Boolean).join(' ')
}

function toPercentLayout(
	panes: SplitViewPane[],
	sizes: number[],
	axisSize: number,
	currentLayout: SplitViewLayout,
) {
	return panes.reduce<SplitViewLayout>(
		(acc, pane, index) => {
			const size = sizes[index]
			if (typeof size === 'number' && axisSize > 0 && size > 0.5 && pane.visible !== false) {
				acc[pane.id] = (size / axisSize) * 100
			}
			return acc
		},
		{ ...currentLayout },
	)
}

function toPixelSizes(paneIds: string[], layout: SplitViewLayout, axisSize: number) {
	return Object.fromEntries(
		paneIds.map((paneId) => [paneId, ((layout[paneId] ?? 0) / 100) * axisSize]),
	)
}

function createLayoutSignature(paneIds: string[], layout: SplitViewLayout, axisSize: number) {
	return paneIds.map((paneId) => `${paneId}:${layout[paneId] ?? 0}`).join('|') + `@${axisSize}`
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

// This adapter is the only place that knows about the current split-pane library.
export const WorkbenchSplitView = forwardRef<SplitViewHandle, WorkbenchSplitViewProps>(
	(
		{
			className,
			layout,
			id,
			onLayoutCommit,
			orientation,
			primary,
			secondary,
			separatorClassName = 'plx-workbench__resizeHandle',
		},
		ref,
	) => {
		const splitRef = useRef<WorksplitHandle | null>(null)
		const hostRef = useRef<HTMLDivElement | null>(null)
		const layoutRef = useRef<SplitViewLayout>({ ...layout })
		const syncedLayoutSignatureRef = useRef('')
		const { axisSize, axisSizeRef } = useObservedAxisSize(hostRef, orientation)
		const panes = useMemo(
			() => (secondary ? [primary, secondary] : [primary]),
			[primary, secondary],
		)
		const paneIds = useMemo(() => panes.map((pane) => pane.id), [panes])
		const defaultSizeById = useMemo(
			() => (axisSize > 0 ? toPixelSizes(paneIds, layout, axisSize) : undefined),
			[axisSize, layout, paneIds],
		)

		useLayoutEffect(() => {
			layoutRef.current = { ...layout }
			const currentAxisSize = axisSizeRef.current || axisSize
			if (currentAxisSize <= 0) return
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
			}),
			[paneIds],
		)

		const handleLayoutCommit = useMemo(() => {
			if (!onLayoutCommit) return undefined
			return ({ phase, reason, sizes }: SplitViewLayoutEvent) => {
				if (phase !== 'commit' || (reason !== 'pointer' && reason !== 'keyboard')) return
				const nextLayout = toPercentLayout(
					panes,
					sizes,
					axisSizeRef.current || axisSize,
					layoutRef.current,
				)
				layoutRef.current = nextLayout
				onLayoutCommit(nextLayout)
			}
		}, [axisSize, axisSizeRef, onLayoutCommit, panes])

		const renderedPanes = useMemo(
			() =>
				panes.map((pane) => (
					<Pane
						key={pane.id}
						id={pane.id}
						minSize={axisSize > 0 ? (axisSize * pane.minSize) / 100 : undefined}
						defaultSize={toPanelSize(pane.defaultSize)}
						snap={pane.snap}
						visible={pane.visible}
					>
						<div style={PANEL_STYLE}>{pane.children}</div>
					</Pane>
				)),
			[axisSize, panes],
		)

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
				>
					{renderedPanes}
				</SplitView>
			</div>
		)
	},
)

WorkbenchSplitView.displayName = 'WorkbenchSplitView'
