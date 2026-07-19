declare module '@worksplit/react/style.css'

declare module '@worksplit/react' {
	import type {
		CSSProperties,
		ForwardRefExoticComponent,
		HTMLAttributes,
		ReactNode,
		RefAttributes,
	} from 'react'

	export type PaneSizeValue = number | `${number}px` | `${number}%` | `${number}fr`
	export type SplitOrientation = 'horizontal' | 'vertical'

	export interface PaneProps extends HTMLAttributes<HTMLDivElement> {
		id: string
		children: ReactNode
		minSize?: number
		maxSize?: number
		defaultSize?: PaneSizeValue
		defaultVisible?: boolean
		collapsedSize?: number
		visible?: boolean
		snap?: boolean
		snapThreshold?: number
		snapCollapseDelay?: number
	}

	export interface SplitLayout {
		containerSize: number
		contentSize: number
		sizes: number[]
		sizeById: Record<string, number>
		visibleIds: string[]
	}

	export interface SplitViewHandle {
		reset(): void
		setPaneSizes(sizeById: Record<string, number>): void
		resizePane(id: string, size: number): void
		collapsePane(id: string): void
		expandPane(id: string): void
		togglePane(id: string): void
		isPaneVisible(id: string): boolean
		getLayout(): SplitLayout | null
	}

	export interface SplitViewLayoutEvent {
		layout: SplitLayout
		phase: 'start' | 'change' | 'commit'
		reason: 'pointer' | 'keyboard' | 'visibility' | 'reset' | 'imperative'
		sizes: number[]
		sizeById: Record<string, number>
	}

	export interface SplitViewPaneVisibilityChange {
		id: string
		visible: boolean
	}

	export interface SplitViewProps extends Omit<
		HTMLAttributes<HTMLDivElement>,
		'children' | 'onChange'
	> {
		children: ReactNode
		orientation?: SplitOrientation
		defaultSizeById?: Record<string, number | undefined>
		sashSize?: number
		disabled?: boolean
		proportionalResize?: boolean
		style?: CSSProperties
		onLayout?: (event: SplitViewLayoutEvent) => void
		onPaneVisibilityChange?: (event: SplitViewPaneVisibilityChange) => void
	}

	export const Pane: ForwardRefExoticComponent<PaneProps & RefAttributes<HTMLDivElement>>
	export const SplitView: ForwardRefExoticComponent<SplitViewProps & RefAttributes<SplitViewHandle>>
}
