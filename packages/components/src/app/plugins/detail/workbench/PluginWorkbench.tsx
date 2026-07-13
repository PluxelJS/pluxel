import { useCallback, useMemo, useRef, useState } from 'react'
import { useMediaQuery } from '@mantine/hooks'
import type { PluginConfigState } from '../../config/usePluginConfig'
import {
	DEFAULT_PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT,
	DEFAULT_PLUGIN_WORKBENCH_VERTICAL_LAYOUT,
	PLUGIN_WORKBENCH_ASIDE_PANEL_ID,
	PLUGIN_WORKBENCH_CONTENT_PANEL_ID,
	PLUGIN_WORKBENCH_DOCK_PANEL_ID,
	PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT_STORAGE_KEY,
	PLUGIN_WORKBENCH_MAIN_PANEL_ID,
	PLUGIN_WORKBENCH_VERTICAL_LAYOUT_STORAGE_KEY,
	sanitizePluginWorkbenchHorizontalLayout,
	sanitizePluginWorkbenchVerticalLayout,
	WorkbenchSplitView,
	type SplitViewHandle,
	type SplitViewPane,
	useStoredSplitLayout,
	useSyncedLayout,
} from '../../../workbench/split'
import { RightPane } from '../RightPane'
import { PluginWorkbenchPanel, PluginWorkbenchSidebar } from './PluginWorkbenchHostViews'
import { PluginWorkbenchAsideProvider, usePluginWorkbenchLayout } from './context'

export function PluginWorkbench({ config }: { config: PluginConfigState }) {
	const isNarrowViewport = useMediaQuery('(max-width: 47.99em)')
	const horizontalGroupRef = useRef<SplitViewHandle | null>(null)
	const verticalGroupRef = useRef<SplitViewHandle | null>(null)
	const [assistHost, setAssistHostState] = useState<HTMLDivElement | null>(null)
	const [assistVisible, setAssistPanelVisible] = useState(false)
	const assistClaimsRef = useRef(new Map<symbol, true>())
	const { dockVisible, rightPaneVisible, setDockVisible, setRightPaneVisible } =
		usePluginWorkbenchLayout()
	const [horizontalLayout, handleHorizontalLayoutChanged] = useStoredSplitLayout(
		PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT_STORAGE_KEY,
		DEFAULT_PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT,
		sanitizePluginWorkbenchHorizontalLayout,
	)
	const [verticalLayout, handleVerticalLayoutChanged] = useStoredSplitLayout(
		PLUGIN_WORKBENCH_VERTICAL_LAYOUT_STORAGE_KEY,
		DEFAULT_PLUGIN_WORKBENCH_VERTICAL_LAYOUT,
		sanitizePluginWorkbenchVerticalLayout,
	)
	const setAssistHost = useCallback((node: HTMLDivElement | null) => {
		setAssistHostState((current) => (current === node ? current : node))
	}, [])
	const setAssistClaim = useCallback((owner: symbol, visible: boolean) => {
		const claims = assistClaimsRef.current
		if (visible) claims.set(owner, true)
		else claims.delete(owner)
		setAssistPanelVisible(claims.size > 0)
	}, [])
	const asideContext = useMemo(
		() => ({
			asideAvailable: !isNarrowViewport,
			assistHost,
			setAssistHost,
			assistVisible,
			setAssistClaim,
		}),
		[assistHost, assistVisible, isNarrowViewport, setAssistHost, setAssistClaim],
	)
	useSyncedLayout(horizontalGroupRef, horizontalLayout, rightPaneVisible && !isNarrowViewport)
	useSyncedLayout(verticalGroupRef, verticalLayout, dockVisible && !isNarrowViewport)

	const dockPane = useMemo<SplitViewPane>(
		() => ({
			id: PLUGIN_WORKBENCH_DOCK_PANEL_ID,
			defaultSize: verticalLayout[PLUGIN_WORKBENCH_DOCK_PANEL_ID],
			minSize: 8,
			snap: true,
			visible: dockVisible,
			onVisibleChange: setDockVisible,
			children: <PluginWorkbenchPanel />,
		}),
		[dockVisible, setDockVisible, verticalLayout],
	)

	const contentPane = useMemo<SplitViewPane>(
		() => ({
			id: PLUGIN_WORKBENCH_CONTENT_PANEL_ID,
			defaultSize: verticalLayout[PLUGIN_WORKBENCH_CONTENT_PANEL_ID],
			minSize: 12,
			children: (
				<div className="plx-pluginWorkbench__workspace">
					<RightPane config={config} />
				</div>
			),
		}),
		[config, verticalLayout],
	)

	const asidePane = useMemo<SplitViewPane>(
		() => ({
			id: PLUGIN_WORKBENCH_ASIDE_PANEL_ID,
			defaultSize: horizontalLayout[PLUGIN_WORKBENCH_ASIDE_PANEL_ID],
			minSize: 12,
			snap: true,
			visible: rightPaneVisible,
			onVisibleChange: setRightPaneVisible,
			children: <PluginWorkbenchSidebar />,
		}),
		[horizontalLayout, rightPaneVisible, setRightPaneVisible],
	)

	const mainPane = useMemo<SplitViewPane>(
		() => ({
			id: PLUGIN_WORKBENCH_MAIN_PANEL_ID,
			defaultSize: horizontalLayout[PLUGIN_WORKBENCH_MAIN_PANEL_ID],
			minSize: 44,
			children: isNarrowViewport ? (
				contentPane.children
			) : (
				<WorkbenchSplitView
					className="plx-pluginWorkbench__vertical"
					defaultLayout={verticalLayout}
					id="pluxel-plugin-workbench-vertical"
					onLayoutChanged={dockVisible ? handleVerticalLayoutChanged : undefined}
					orientation="vertical"
					primary={contentPane}
					secondary={dockPane}
					separatorClassName="plx-workbench__resizeHandle plx-workbench__resizeHandle--horizontal"
					ref={verticalGroupRef}
				/>
			),
		}),
		[
			contentPane,
			dockPane,
			dockVisible,
			handleVerticalLayoutChanged,
			horizontalLayout,
			isNarrowViewport,
			verticalLayout,
		],
	)

	return (
		<PluginWorkbenchAsideProvider value={asideContext}>
			<div className="plx-pluginWorkbench">
				<WorkbenchSplitView
					className="plx-pluginWorkbench__horizontal"
					defaultLayout={horizontalLayout}
					id="pluxel-plugin-workbench-horizontal"
					onLayoutChanged={rightPaneVisible ? handleHorizontalLayoutChanged : undefined}
					orientation="horizontal"
					primary={mainPane}
					secondary={isNarrowViewport ? undefined : asidePane}
					ref={horizontalGroupRef}
				/>
			</div>
		</PluginWorkbenchAsideProvider>
	)
}
