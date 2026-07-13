import { sanitizeOptionalBooleanState, sanitizeTwoPanelLayout } from './storage'

export type PluginWorkbenchPanelsState = {
	rightPaneVisible?: boolean
	dockVisible?: boolean
}

export type ResolvedPluginWorkbenchPanelsState = Required<PluginWorkbenchPanelsState>

export const PLUGIN_RAIL_PANEL_ID = 'pluxel-workbench-plugin-nav'
export const PLUGIN_SECTION_CONTENT_PANEL_ID = 'pluxel-workbench-workspace'
export const DEFAULT_PLUGIN_SECTION_LAYOUT = {
	[PLUGIN_RAIL_PANEL_ID]: 18,
	[PLUGIN_SECTION_CONTENT_PANEL_ID]: 82,
}

export const PLUGIN_WORKBENCH_PANELS_SCOPE = 'plugin:workbench:layout'
export const DEFAULT_PLUGIN_WORKBENCH_PANELS_STATE = {
	rightPaneVisible: false,
	dockVisible: false,
} satisfies ResolvedPluginWorkbenchPanelsState

export const PLUGIN_WORKBENCH_MAIN_PANEL_ID = 'pluxel-plugin-workbench-workspace'
export const PLUGIN_WORKBENCH_ASIDE_PANEL_ID = 'pluxel-plugin-workbench-context'
export const PLUGIN_WORKBENCH_CONTENT_PANEL_ID = 'pluxel-plugin-workbench-content'
export const PLUGIN_WORKBENCH_DOCK_PANEL_ID = 'pluxel-plugin-workbench-dock'
export const PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT_STORAGE_KEY = 'pluxel:plugin:workbench:h'
export const PLUGIN_WORKBENCH_VERTICAL_LAYOUT_STORAGE_KEY = 'pluxel:plugin:workbench:v'
export const DEFAULT_PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT = {
	[PLUGIN_WORKBENCH_MAIN_PANEL_ID]: 82,
	[PLUGIN_WORKBENCH_ASIDE_PANEL_ID]: 18,
}
export const DEFAULT_PLUGIN_WORKBENCH_VERTICAL_LAYOUT = {
	[PLUGIN_WORKBENCH_CONTENT_PANEL_ID]: 90,
	[PLUGIN_WORKBENCH_DOCK_PANEL_ID]: 10,
}

export function sanitizePluginSectionLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(layout, DEFAULT_PLUGIN_SECTION_LAYOUT, PLUGIN_RAIL_PANEL_ID, 14, 56)
}

export function sanitizePluginWorkbenchPanelsState(value: unknown): PluginWorkbenchPanelsState {
	return sanitizeOptionalBooleanState<PluginWorkbenchPanelsState>(value, [
		'rightPaneVisible',
		'dockVisible',
	])
}

export function resolvePluginWorkbenchPanelsState(
	value: unknown,
): ResolvedPluginWorkbenchPanelsState {
	const scoped = sanitizePluginWorkbenchPanelsState(value)
	return {
		rightPaneVisible:
			scoped.rightPaneVisible ?? DEFAULT_PLUGIN_WORKBENCH_PANELS_STATE.rightPaneVisible,
		dockVisible: scoped.dockVisible ?? DEFAULT_PLUGIN_WORKBENCH_PANELS_STATE.dockVisible,
	}
}

export function sanitizePluginWorkbenchHorizontalLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(
		layout,
		DEFAULT_PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT,
		PLUGIN_WORKBENCH_MAIN_PANEL_ID,
		44,
		12,
	)
}

export function sanitizePluginWorkbenchVerticalLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(
		layout,
		DEFAULT_PLUGIN_WORKBENCH_VERTICAL_LAYOUT,
		PLUGIN_WORKBENCH_CONTENT_PANEL_ID,
		12,
		8,
	)
}
