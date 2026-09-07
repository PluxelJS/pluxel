import {
	IconLayout2,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconLayoutSidebarRightCollapse,
	IconLayoutSidebarRightExpand,
} from '@tabler/icons-react'
import { useCallback, useSyncExternalStore } from 'react'
import type {
	PaneLayoutControlRegistry,
	PaneLayoutHeaderControls,
	PaneLayoutHeaderSide,
} from './PaneLayoutControlRegistry'
import { WorkbenchLayoutControlGroup, type WorkbenchLayoutControl } from './LayoutControls'

const EMPTY_CONTROLS: readonly PaneLayoutHeaderControls[] = Object.freeze([])

/** Standard header chrome for the focused document's WorkbenchPaneLayout instances. */
export function RemotePaneLayoutControls({
	registry,
	tabId,
}: {
	registry: PaneLayoutControlRegistry
	tabId: string | null
}) {
	const layouts = useSyncExternalStore(
		useCallback((listener) => registry.subscribe(listener), [registry]),
		useCallback(() => registry.entriesFor(tabId), [registry, tabId]),
		() => EMPTY_CONTROLS,
	)
	if (layouts.length === 0) return null
	return layouts.map((layout) => <RemotePaneLayoutControlGroup key={layout.id} layout={layout} />)
}

function RemotePaneLayoutControlGroup({ layout }: { layout: PaneLayoutHeaderControls }) {
	const navigation = layout.sides.find((side) => side.role === 'navigation')
	const inspector = layout.sides.find((side) => side.role === 'inspector')
	if (!navigation && !inspector) return null
	const focusLabel = layout.focusActive
		? `恢复 ${layout.label} 的周边面板`
		: `聚焦 ${layout.label} 的主区`
	const controls: WorkbenchLayoutControl[] = []
	if (navigation) controls.push(sideToggleControl(layout, navigation))
	controls.push({
		active: layout.focusActive,
		children: <IconLayout2 size={18} />,
		id: 'focus',
		kind: 'action',
		label: focusLabel,
		onClick: layout.toggleFocus,
	})
	if (inspector) controls.push(sideToggleControl(layout, inspector))
	return (
		<WorkbenchLayoutControlGroup
			className="plx-workbench__remotePaneControls"
			controls={controls}
		/>
	)
}

function sideToggleControl(
	layout: PaneLayoutHeaderControls,
	side: PaneLayoutHeaderSide,
): WorkbenchLayoutControl {
	const isNavigation = side.role === 'navigation'
	const hideLabel = `隐藏 ${layout.label} 的 ${side.title}`
	const showLabel = `显示 ${layout.label} 的 ${side.title}`
	return {
		id: side.id,
		kind: 'toggle',
		hiddenIcon: isNavigation ? (
			<IconLayoutSidebarLeftCollapse size={18} />
		) : (
			<IconLayoutSidebarRightCollapse size={18} />
		),
		hideLabel,
		onClick: () => layout.toggle(side.id),
		showIcon: isNavigation ? (
			<IconLayoutSidebarLeftExpand size={18} />
		) : (
			<IconLayoutSidebarRightExpand size={18} />
		),
		showLabel,
		visible: side.visible,
	}
}
