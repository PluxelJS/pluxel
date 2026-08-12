import {
	WorkbenchPaneLayoutControlsProvider,
	type WorkbenchPaneDescriptor,
	type WorkbenchPaneLayoutControls,
	type WorkbenchPaneLayoutMode,
	type WorkbenchPaneLayoutRendererProps,
	type WorkbenchViewState,
} from '@pluxel/runtime/workbench/ui/internal'
import {
	createContext,
	useContext,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import {
	WorkbenchSplitView,
	type SplitViewHandle,
	type SplitViewLayout,
	type SplitViewPane,
} from './split'

const PANE_STATE_VERSION = 1
const MEDIUM_BREAKPOINT = 1_100
const COMPACT_BREAKPOINT = 720
const EMPTY_LAYOUT = Object.freeze({})

type PersistedPaneState = Readonly<{
	version: typeof PANE_STATE_VERSION
	layout: Readonly<Record<string, number>>
	visibility: Readonly<Record<string, boolean>>
}>

type HostRemotePaneLayoutProps = WorkbenchPaneLayoutRendererProps

const RemotePaneStateContext = createContext<WorkbenchViewState | undefined>(undefined)

export function RemotePaneLayoutStateProvider({
	state,
	children,
}: {
	state?: WorkbenchViewState
	children: ReactNode
}) {
	return <RemotePaneStateContext.Provider value={state}>{children}</RemotePaneStateContext.Provider>
}

export function HostRemotePaneLayout({
	id,
	panes,
	className,
	style,
	label,
}: HostRemotePaneLayoutProps) {
	const hostState = useContext(RemotePaneStateContext)
	const hostRef = useRef<HTMLDivElement | null>(null)
	const splitRef = useRef<SplitViewHandle | null>(null)
	const [mode, setMode] = useState<WorkbenchPaneLayoutMode>('wide')
	const [activeDrawer, setActiveDrawer] = useState<string | null>(null)
	const [memoryState, setMemoryState] = useState<PersistedPaneState>(() => defaultState(panes))
	const scope = `pane-layout:${id}`
	const hostSnapshot = useSyncExternalStore(
		useCallback(
			(listener) => hostState?.subscribe(scope, listener) ?? (() => {}),
			[hostState, scope],
		),
		useCallback(() => hostState?.read(scope), [hostState, scope]),
		useCallback(() => undefined, []),
	)
	const state = useMemo(
		() => sanitizeRemotePaneState(hostSnapshot, panes) ?? memoryState,
		[hostSnapshot, memoryState, panes],
	)
	const stateRef = useRef(state)
	stateRef.current = state
	const writeState = useCallback(
		(next: PersistedPaneState) => {
			stateRef.current = next
			if (hostState) hostState.write(scope, next)
			else setMemoryState(next)
		},
		[hostState, scope],
	)

	useLayoutEffect(() => {
		const host = hostRef.current
		if (!host) return undefined
		const update = () => setMode(resolveMode(host.clientWidth))
		update()
		if (typeof ResizeObserver === 'undefined') return undefined
		const observer = new ResizeObserver(update)
		observer.observe(host)
		return () => observer.disconnect()
	}, [])

	useEffect(() => {
		if (activeDrawer && !isResponsiveDrawer(paneById(panes, activeDrawer), mode)) {
			setActiveDrawer(null)
		}
	}, [activeDrawer, mode, panes])

	const show = useCallback(
		(paneId: string) => {
			const pane = requirePane(panes, paneId)
			if (!canCollapse(pane)) return
			if (isResponsiveDrawer(pane, mode)) {
				setActiveDrawer(paneId)
				return
			}
			writeState(withVisibility(stateRef.current, paneId, true))
		},
		[mode, panes, writeState],
	)
	const hide = useCallback(
		(paneId: string) => {
			const pane = requirePane(panes, paneId)
			if (!canCollapse(pane)) return
			if (isResponsiveDrawer(pane, mode)) {
				setActiveDrawer((current) => (current === paneId ? null : current))
				return
			}
			writeState(withVisibility(stateRef.current, paneId, false))
		},
		[mode, panes, writeState],
	)
	const toggle = useCallback(
		(paneId: string) => {
			const pane = requirePane(panes, paneId)
			if (!canCollapse(pane)) return
			if (isResponsiveDrawer(pane, mode)) {
				setActiveDrawer((current) => (current === paneId ? null : paneId))
				return
			}
			const visible = stateRef.current.visibility[paneId] ?? pane.defaultVisible !== false
			writeState(withVisibility(stateRef.current, paneId, !visible))
		},
		[mode, panes, writeState],
	)
	const reset = useCallback(() => {
		writeState(defaultState(panes))
		splitRef.current?.reset()
		setActiveDrawer(null)
	}, [panes, writeState])
	const controls = useMemo<WorkbenchPaneLayoutControls>(
		() => ({ mode, activeDrawer, show, hide, toggle, reset }),
		[activeDrawer, hide, mode, reset, show, toggle],
	)
	const responsivePanes = useMemo(
		() => panes.filter((pane) => isResponsiveDrawer(pane, mode)),
		[mode, panes],
	)
	const drawerOpen = activeDrawer !== null
	const renderedPanes = useMemo<readonly SplitViewPane[]>(
		() =>
			panes.map((pane) => {
				const responsive = isResponsiveDrawer(pane, mode)
				const open = responsive && activeDrawer === pane.id
				const persistedVisible =
					pane.role === 'primary'
						? true
						: (state.visibility[pane.id] ?? pane.defaultVisible !== false)
				return {
					id: pane.id,
					defaultSize: pane.defaultSize ?? defaultPaneSize(pane),
					minSize: responsive ? 0 : (pane.minSize ?? defaultMinSize(pane)),
					maxSize: pane.maxSize,
					snap: !responsive && canCollapse(pane),
					visible: responsive ? true : persistedVisible,
					onVisibleChange: responsive
						? undefined
						: (visible) => writeState(withVisibility(stateRef.current, pane.id, visible)),
					collapsedContent:
						!responsive && canCollapse(pane)
							? (restore) => (
									<button
										className="plx-remotePaneLayout__restore"
										type="button"
										onClick={restore}
										aria-label={`Show ${pane.title}`}
										title={`Show ${pane.title}`}
									>
										{pane.role === 'navigation' ? '›' : '‹'}
									</button>
								)
							: undefined,
					className: joinClasses(
						'plx-remotePaneLayout__paneHost',
						responsive ? 'plx-remotePaneLayout__paneHost--responsive' : undefined,
						open ? 'plx-remotePaneLayout__paneHost--drawerOpen' : undefined,
					),
					style: responsivePaneStyle(responsive, open, pane.role),
					ariaHidden: (responsive && !open) || (drawerOpen && !open),
					inert: (responsive && !open) || (drawerOpen && !open),
					children: (
						<PaneContent
							pane={pane}
							mode={mode}
							drawer={responsive && open}
							onClose={() => (responsive ? setActiveDrawer(null) : hide(pane.id))}
						/>
					),
				}
			}),
		[activeDrawer, drawerOpen, hide, mode, panes, state, writeState],
	)

	useLayoutEffect(() => {
		const handle = splitRef.current
		if (!handle) return
		if (Object.keys(state.layout).length === 0) {
			handle.reset()
		} else {
			handle.setLayout(state.layout as SplitViewLayout)
		}
		for (const pane of responsivePanes) handle.resizePane(pane.id, 0)
	}, [mode, responsivePanes, state.layout])

	return (
		<WorkbenchPaneLayoutControlsProvider value={controls}>
			<div
				ref={hostRef}
				className={joinClasses('plx-remotePaneLayout', className)}
				style={style}
				data-mode={mode}
				aria-label={label}
			>
				{responsivePanes.length > 0 ? (
					<div
						className="plx-remotePaneLayout__responsiveBar"
						role="toolbar"
						aria-label="Pane controls"
					>
						{responsivePanes.map((pane) => (
							<button
								key={pane.id}
								type="button"
								className="plx-remotePaneLayout__toolbarButton"
								data-active={activeDrawer === pane.id ? 'true' : 'false'}
								onClick={() => toggle(pane.id)}
								aria-expanded={activeDrawer === pane.id}
							>
								{pane.title}
							</button>
						))}
						<button
							type="button"
							className="plx-remotePaneLayout__toolbarButton plx-remotePaneLayout__reset"
							onClick={reset}
						>
							Reset layout
						</button>
					</div>
				) : null}
				<div className="plx-remotePaneLayout__main">
					<WorkbenchSplitView
						id={`pluxel-remote-pane-${id}`}
						layout={state.layout as SplitViewLayout}
						onLayoutCommit={(layout) => writeState({ ...stateRef.current, layout })}
						orientation="horizontal"
						panes={renderedPanes}
						ref={splitRef}
						separatorClassName="plx-remotePaneLayout__split"
					/>
				</div>
				{drawerOpen ? (
					<DrawerScrim
						title={paneById(panes, activeDrawer)?.title ?? ''}
						onClose={() => setActiveDrawer(null)}
					/>
				) : null}
			</div>
		</WorkbenchPaneLayoutControlsProvider>
	)
}

function DrawerScrim({ title, onClose }: { title: string; onClose: () => void }) {
	return (
		<button
			type="button"
			className="plx-remotePaneLayout__scrim"
			onClick={onClose}
			aria-label={`Close ${title}`}
		/>
	)
}

function PaneContent({
	pane,
	mode,
	drawer,
	onClose,
}: {
	pane: WorkbenchPaneDescriptor
	mode: WorkbenchPaneLayoutMode
	drawer: boolean
	onClose: () => void
}) {
	const rootRef = useRef<HTMLElement | null>(null)
	const previousFocusRef = useRef<HTMLElement | null>(null)
	useEffect(() => {
		if (!drawer) return undefined
		previousFocusRef.current = document.activeElement as HTMLElement | null
		const root = rootRef.current
		const focusable = root?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
		;(focusable ?? root)?.focus()
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault()
				onClose()
				return
			}
			if (event.key !== 'Tab') return
			const focusableItems = [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
			if (focusableItems.length === 0) {
				event.preventDefault()
				root?.focus()
				return
			}
			const first = focusableItems[0]!
			const last = focusableItems.at(-1)!
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault()
				last.focus()
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault()
				first.focus()
			}
		}
		root?.addEventListener('keydown', onKeyDown)
		return () => {
			root?.removeEventListener('keydown', onKeyDown)
			previousFocusRef.current?.focus()
		}
	}, [drawer, onClose])
	return (
		<section
			ref={rootRef}
			className={joinClasses('plx-remotePane', pane.className)}
			style={pane.style}
			data-role={pane.role}
			data-drawer={drawer ? 'true' : 'false'}
			role={drawer ? 'dialog' : undefined}
			aria-modal={drawer || undefined}
			aria-label={drawer ? pane.title : undefined}
			tabIndex={drawer ? -1 : undefined}
		>
			<header className="plx-remotePane__header">
				<div className="plx-remotePane__heading">
					<strong>{pane.title}</strong>
					{pane.description ? <span>{pane.description}</span> : null}
				</div>
				{pane.actions ? <div className="plx-remotePane__actions">{pane.actions}</div> : null}
				{drawer || (canCollapse(pane) && mode === 'wide') ? (
					<button
						type="button"
						className="plx-remotePane__close"
						onClick={onClose}
						aria-label={`Close ${pane.title}`}
					>
						×
					</button>
				) : null}
			</header>
			<div className="plx-remotePane__body" data-scroll={pane.scroll ?? 'auto'}>
				{pane.content}
			</div>
		</section>
	)
}

function defaultState(panes: readonly WorkbenchPaneDescriptor[]): PersistedPaneState {
	return Object.freeze({
		version: PANE_STATE_VERSION,
		layout: EMPTY_LAYOUT,
		visibility: Object.freeze(
			Object.fromEntries(
				panes.map((pane) => [pane.id, pane.role === 'primary' || pane.defaultVisible !== false]),
			),
		) as Readonly<Record<string, boolean>>,
	})
}

export function sanitizeRemotePaneState(
	value: unknown,
	panes: readonly WorkbenchPaneDescriptor[],
): PersistedPaneState | undefined {
	if (!isRecord(value) || value.version !== PANE_STATE_VERSION) return undefined
	const ids = new Set(panes.map((pane) => pane.id))
	const layout = isRecord(value.layout)
		? Object.fromEntries(
				Object.entries(value.layout).filter(
					(entry): entry is [string, number] =>
						ids.has(entry[0]) &&
						typeof entry[1] === 'number' &&
						Number.isFinite(entry[1]) &&
						entry[1] >= 0 &&
						entry[1] <= 100,
				),
			)
		: {}
	const visibility = Object.fromEntries(
		panes.map((pane) => [
			pane.id,
			pane.role === 'primary'
				? true
				: isRecord(value.visibility) && typeof value.visibility[pane.id] === 'boolean'
					? value.visibility[pane.id]
					: pane.defaultVisible !== false,
		]),
	) as Record<string, boolean>
	return Object.freeze({ version: PANE_STATE_VERSION, layout, visibility })
}

function withVisibility(
	state: PersistedPaneState,
	paneId: string,
	visible: boolean,
): PersistedPaneState {
	return Object.freeze({
		...state,
		visibility: Object.freeze({ ...state.visibility, [paneId]: visible }),
	})
}

function defaultPaneSize(pane: WorkbenchPaneDescriptor) {
	if (pane.role === 'primary') return '1fr' as const
	return pane.role === 'navigation' ? 260 : 300
}

function defaultMinSize(pane: WorkbenchPaneDescriptor) {
	return pane.role === 'primary' ? 320 : 220
}

function defaultCollapseAt(pane: WorkbenchPaneDescriptor) {
	if (pane.role === 'navigation') return 'compact'
	if (pane.role === 'inspector') return 'medium'
	return 'never'
}

function canCollapse(pane: WorkbenchPaneDescriptor) {
	return pane.role !== 'primary' && pane.collapsible !== false
}

function isResponsiveDrawer(
	pane: WorkbenchPaneDescriptor | undefined,
	mode: WorkbenchPaneLayoutMode,
) {
	if (!pane || pane.role === 'primary') return false
	const collapseAt = pane.collapseAt ?? defaultCollapseAt(pane)
	return (
		(collapseAt === 'medium' && mode !== 'wide') || (collapseAt === 'compact' && mode === 'compact')
	)
}

function responsivePaneStyle(
	responsive: boolean,
	open: boolean,
	role: WorkbenchPaneDescriptor['role'],
) {
	if (!responsive) return undefined
	return {
		left: role === 'navigation' ? 0 : 'auto',
		right: role === 'inspector' ? 0 : 'auto',
		top: 0,
		bottom: 0,
		width: 'min(390px, calc(100% - 34px))',
		display: open ? 'block' : 'none',
	} as const
}

function resolveMode(width: number): WorkbenchPaneLayoutMode {
	if (width <= COMPACT_BREAKPOINT) return 'compact'
	if (width <= MEDIUM_BREAKPOINT) return 'medium'
	return 'wide'
}

function paneById(panes: readonly WorkbenchPaneDescriptor[], paneId: string | null) {
	return paneId ? panes.find((pane) => pane.id === paneId) : undefined
}

function requirePane(panes: readonly WorkbenchPaneDescriptor[], paneId: string) {
	const pane = paneById(panes, paneId)
	if (!pane) throw new Error(`Unknown WorkbenchPane: ${paneId}`)
	return pane
}

function joinClasses(...values: Array<string | undefined>) {
	return values.filter(Boolean).join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
