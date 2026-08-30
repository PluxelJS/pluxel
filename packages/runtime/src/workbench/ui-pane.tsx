import {
	Children,
	createContext,
	isValidElement,
	useContext,
	useMemo,
	type CSSProperties,
	type ComponentType,
	type ReactElement,
	type ReactNode,
} from 'react'
import { useWorkbenchReactRuntime } from './react-context'

const PANE_COMPONENT = Symbol.for('@pluxel/runtime/workbench-pane')
const SAFE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/

export type WorkbenchPaneRole = 'navigation' | 'primary' | 'inspector'
export type WorkbenchPaneCollapseAt = 'medium' | 'compact' | 'never'
export type WorkbenchPaneLayoutMode = 'wide' | 'medium' | 'compact'
export type WorkbenchPaneSize = number | `${number}%` | `${number}fr`

export type WorkbenchPaneProps = Readonly<{
	id: string
	role: WorkbenchPaneRole
	title: string
	description?: string
	children: ReactNode
	actions?: ReactNode
	defaultSize?: WorkbenchPaneSize
	minSize?: number
	maxSize?: number
	defaultVisible?: boolean
	collapsible?: boolean
	collapseAt?: WorkbenchPaneCollapseAt
	scroll?: 'auto' | 'hidden'
	className?: string
	style?: CSSProperties
}>

export type WorkbenchPaneLayoutProps = Readonly<{
	id: string
	children: ReactNode
	className?: string
	style?: CSSProperties
	label?: string
}>

export type WorkbenchPaneLayoutControls = Readonly<{
	mode: WorkbenchPaneLayoutMode
	activeDrawer: string | null
	show(id: string): void
	hide(id: string): void
	toggle(id: string): void
	reset(): void
}>

/** @internal Normalized descriptor consumed only by the host-owned renderer. */
export type WorkbenchPaneDescriptor = Readonly<
	Omit<WorkbenchPaneProps, 'children'> & { content: ReactNode }
>

/** @internal Public declarations are rendered by a host adapter; its split library stays private. */
export type WorkbenchPaneLayoutRendererProps = Readonly<{
	id: string
	panes: readonly WorkbenchPaneDescriptor[]
	className?: string
	style?: CSSProperties
	label: string
}>

/** @internal Injected into each hosted View by the Workbench runtime. */
export type WorkbenchPaneLayoutRenderer = ComponentType<WorkbenchPaneLayoutRendererProps>

const WorkbenchPaneLayoutContext = createContext<WorkbenchPaneLayoutControls | null>(null)

export function useWorkbenchPaneLayout(): WorkbenchPaneLayoutControls {
	const value = useContext(WorkbenchPaneLayoutContext)
	if (!value) throw new Error('useWorkbenchPaneLayout() requires WorkbenchPaneLayout')
	return value
}

/** @internal Host renderer bridge for the public hook. */
export function WorkbenchPaneLayoutControlsProvider({
	value,
	children,
}: {
	value: WorkbenchPaneLayoutControls
	children: ReactNode
}) {
	return (
		<WorkbenchPaneLayoutContext.Provider value={value}>
			{children}
		</WorkbenchPaneLayoutContext.Provider>
	)
}

export function WorkbenchPane(_props: WorkbenchPaneProps): ReactNode {
	throw new Error('WorkbenchPane must be a direct child of WorkbenchPaneLayout')
}

;(WorkbenchPane as typeof WorkbenchPane & { [PANE_COMPONENT]?: boolean })[PANE_COMPONENT] = true

export function WorkbenchPaneLayout({
	id,
	children,
	className,
	style,
	label = 'Workbench panes',
}: WorkbenchPaneLayoutProps) {
	const panes = useMemo(() => collectAndValidatePanes(id, children), [children, id])
	const Renderer = useWorkbenchReactRuntime().paneLayoutRenderer
	if (!Renderer) {
		throw new Error('WorkbenchPaneLayout is unavailable in the current host')
	}
	return <Renderer id={id} panes={panes} className={className} style={style} label={label} />
}

type PaneElement = ReactElement<WorkbenchPaneProps> & {
	type: typeof WorkbenchPane & { [PANE_COMPONENT]?: boolean }
}

function collectAndValidatePanes(
	id: string,
	children: ReactNode,
): readonly WorkbenchPaneDescriptor[] {
	if (!SAFE_ID.test(id)) {
		throw new Error(
			'WorkbenchPaneLayout.id must start with a letter and contain at most 64 letters, numbers, dots, underscores, or dashes',
		)
	}
	const elements = Children.toArray(children).map((child) => {
		if (!isValidElement(child)) {
			throw new Error('WorkbenchPaneLayout accepts only direct WorkbenchPane children')
		}
		const element = child as PaneElement
		if (!element.type?.[PANE_COMPONENT]) {
			throw new Error('WorkbenchPaneLayout accepts only direct WorkbenchPane children')
		}
		return element
	})
	if (elements.length === 0 || elements.length > 3) {
		throw new Error('WorkbenchPaneLayout requires between one and three panes')
	}

	const ids = new Set<string>()
	const roles = new Set<WorkbenchPaneRole>()
	let primaryCount = 0
	for (const element of elements) {
		const pane = element.props
		if (!SAFE_ID.test(pane.id)) {
			throw new Error(
				'WorkbenchPane.id must start with a letter and contain at most 64 letters, numbers, dots, underscores, or dashes',
			)
		}
		if (ids.has(pane.id)) throw new Error(`Duplicate WorkbenchPane id: ${pane.id}`)
		ids.add(pane.id)
		if (roles.has(pane.role)) throw new Error(`Duplicate WorkbenchPane role: ${pane.role}`)
		roles.add(pane.role)
		if (!pane.title.trim()) throw new Error(`WorkbenchPane "${pane.id}" title is required`)
		if (pane.role === 'primary') {
			primaryCount += 1
			if (pane.defaultVisible === false || pane.collapsible === true) {
				throw new Error(
					'The primary WorkbenchPane must always be visible and cannot be collapsible',
				)
			}
			if (pane.collapseAt && pane.collapseAt !== 'never') {
				throw new Error('The primary WorkbenchPane cannot become a responsive drawer')
			}
		}
		validateSize(pane)
	}
	if (primaryCount !== 1) {
		throw new Error('WorkbenchPaneLayout requires exactly one primary pane')
	}
	return Object.freeze(
		elements.map(({ props: { children: content, ...props } }) =>
			Object.freeze({ ...props, content }),
		),
	)
}

function validateSize(pane: WorkbenchPaneProps): void {
	for (const [name, value] of [
		['minSize', pane.minSize],
		['maxSize', pane.maxSize],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
			throw new Error(`WorkbenchPane "${pane.id}" ${name} must be a finite non-negative number`)
		}
	}
	if (pane.minSize !== undefined && pane.maxSize !== undefined && pane.maxSize < pane.minSize) {
		throw new Error(`WorkbenchPane "${pane.id}" maxSize cannot be smaller than minSize`)
	}
	const value = pane.defaultSize
	if (value === undefined) return
	const unit =
		typeof value === 'string'
			? value.endsWith('%')
				? '%'
				: value.endsWith('fr')
					? 'fr'
					: undefined
			: undefined
	const source =
		typeof value === 'string' && unit ? value.slice(0, unit === '%' ? -1 : -2) : undefined
	const numeric =
		typeof value === 'number'
			? value
			: source && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(source)
				? Number(source)
				: Number.NaN
	if (!Number.isFinite(numeric) || numeric <= 0) {
		throw new Error(`WorkbenchPane "${pane.id}" defaultSize must be positive and finite`)
	}
	if (unit === '%' && numeric > 100) {
		throw new Error(`WorkbenchPane "${pane.id}" percentage defaultSize cannot exceed 100%`)
	}
}
