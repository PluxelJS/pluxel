import {
	resolveLayoutValue,
	sanitizeOptionalBooleanState,
	sanitizeTwoPanelLayout,
} from './storage'

export type OpsWorkbenchPanelsState = {
	sidebarVisible?: boolean
	inspectorVisible?: boolean
}

export type ResolvedOpsWorkbenchPanelsState = Required<OpsWorkbenchPanelsState>

export const OPS_WORKBENCH_PANELS_SCOPE = 'ops:workbench:panes'
export const DEFAULT_OPS_WORKBENCH_PANELS_STATE = {
	sidebarVisible: true,
	inspectorVisible: true,
} satisfies ResolvedOpsWorkbenchPanelsState

export const OPS_WORKBENCH_SIDEBAR_PANEL_ID = 'pluxel-ops-workbench-sidebar'
export const OPS_WORKBENCH_MAIN_PANEL_ID = 'pluxel-ops-workbench-main'
export const OPS_WORKBENCH_CATALOG_PANEL_ID = 'pluxel-ops-workbench-catalog'
export const OPS_WORKBENCH_INSPECTOR_PANEL_ID = 'pluxel-ops-workbench-inspector'

export const OPS_WORKBENCH_HORIZONTAL_LAYOUT_SCOPE = 'ops:workbench:layout:h'
export const OPS_WORKBENCH_CONTENT_LAYOUT_SCOPE = 'ops:workbench:layout:content'

export const DEFAULT_OPS_WORKBENCH_HORIZONTAL_LAYOUT = {
	[OPS_WORKBENCH_SIDEBAR_PANEL_ID]: 22,
	[OPS_WORKBENCH_MAIN_PANEL_ID]: 78,
}

export const DEFAULT_OPS_WORKBENCH_CONTENT_LAYOUT = {
	[OPS_WORKBENCH_CATALOG_PANEL_ID]: 64,
	[OPS_WORKBENCH_INSPECTOR_PANEL_ID]: 36,
}

export function sanitizeOpsWorkbenchPanelsState(value: unknown): OpsWorkbenchPanelsState {
	return sanitizeOptionalBooleanState<OpsWorkbenchPanelsState>(value, [
		'sidebarVisible',
		'inspectorVisible',
	])
}

export function resolveOpsWorkbenchPanelsState(
	value: unknown,
): ResolvedOpsWorkbenchPanelsState {
	const scoped = sanitizeOpsWorkbenchPanelsState(value)
	return {
		sidebarVisible: scoped.sidebarVisible ?? DEFAULT_OPS_WORKBENCH_PANELS_STATE.sidebarVisible,
		inspectorVisible:
			scoped.inspectorVisible ?? DEFAULT_OPS_WORKBENCH_PANELS_STATE.inspectorVisible,
	}
}

export function sanitizeOpsWorkbenchHorizontalLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(
		layout,
		DEFAULT_OPS_WORKBENCH_HORIZONTAL_LAYOUT,
		OPS_WORKBENCH_MAIN_PANEL_ID,
		48,
		14,
	)
}

export function sanitizeOpsWorkbenchContentLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(
		layout,
		DEFAULT_OPS_WORKBENCH_CONTENT_LAYOUT,
		OPS_WORKBENCH_CATALOG_PANEL_ID,
		36,
		18,
	)
}

export function resolveOpsWorkbenchHorizontalLayout(value: unknown) {
	return resolveLayoutValue(
		value,
		DEFAULT_OPS_WORKBENCH_HORIZONTAL_LAYOUT,
		sanitizeOpsWorkbenchHorizontalLayout,
	)
}

export function resolveOpsWorkbenchContentLayout(value: unknown) {
	return resolveLayoutValue(
		value,
		DEFAULT_OPS_WORKBENCH_CONTENT_LAYOUT,
		sanitizeOpsWorkbenchContentLayout,
	)
}
