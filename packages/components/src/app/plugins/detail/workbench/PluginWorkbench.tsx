import {
	Group as PanelGroup,
	type GroupImperativeHandle,
	type Layout,
	Panel,
	Separator as PanelSeparator,
} from 'react-resizable-panels'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PluginConfigState } from '../../../hooks'
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
} from '../../../workbench/pluginLayout'
import { hasSameLayout, useStoredLayout } from '../../../workbench/storage'
import { RightPane } from '../RightPane'
import { PluginWorkbenchPanel, PluginWorkbenchSidebar } from './PluginWorkbenchHostViews'
import { PluginWorkbenchAsideProvider, usePluginWorkbenchLayout } from './context'

const LEGACY_ASSIST_OWNER = Symbol('plugin-workbench-assist-legacy')

const PANEL_STYLE = {
	display: 'flex',
	flexDirection: 'column' as const,
	height: '100%',
	minHeight: 0,
	minWidth: 0,
}

export function PluginWorkbench({ config }: { config: PluginConfigState }) {
	const horizontalGroupRef = useRef<GroupImperativeHandle | null>(null)
	const verticalGroupRef = useRef<GroupImperativeHandle | null>(null)
	const [assistHost, setAssistHostState] = useState<HTMLDivElement | null>(null)
	const [assistVisible, setAssistVisibleState] = useState(false)
	const assistClaimsRef = useRef(new Map<symbol, true>())
	const { dockVisible, rightPaneVisible } = usePluginWorkbenchLayout()
	const [horizontalLayout, setHorizontalLayout] = useStoredLayout(
		PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT_STORAGE_KEY,
		DEFAULT_PLUGIN_WORKBENCH_HORIZONTAL_LAYOUT,
		sanitizePluginWorkbenchHorizontalLayout,
	)
	const [verticalLayout, setVerticalLayout] = useStoredLayout(
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
		setAssistVisibleState(claims.size > 0)
	}, [])
	const setAssistVisible = useCallback(
		(visible: boolean) => {
			setAssistClaim(LEGACY_ASSIST_OWNER, visible)
		},
		[setAssistClaim],
	)
	const asideContext = useMemo(
		() => ({
			asideAvailable: true,
			assistHost,
			setAssistHost,
			assistVisible,
			setAssistVisible,
			setAssistClaim,
		}),
		[assistHost, assistVisible, setAssistHost, setAssistVisible, setAssistClaim],
	)
	const horizontalGroupKey = rightPaneVisible ? 'split' : 'content-only'
	const verticalGroupKey = dockVisible ? 'with-dock' : 'content-only'
	const handleHorizontalLayoutChanged = useCallback(
		(layout: Layout) => {
			setHorizontalLayout((current) =>
				sanitizePluginWorkbenchHorizontalLayout({
					...current,
					[PLUGIN_WORKBENCH_MAIN_PANEL_ID]:
						layout[PLUGIN_WORKBENCH_MAIN_PANEL_ID] ?? current[PLUGIN_WORKBENCH_MAIN_PANEL_ID],
					[PLUGIN_WORKBENCH_ASIDE_PANEL_ID]:
						layout[PLUGIN_WORKBENCH_ASIDE_PANEL_ID] ?? current[PLUGIN_WORKBENCH_ASIDE_PANEL_ID],
				}),
			)
		},
		[setHorizontalLayout],
	)
	const handleVerticalLayoutChanged = useCallback(
		(layout: Layout) => {
			setVerticalLayout((current) =>
				sanitizePluginWorkbenchVerticalLayout({
					...current,
					[PLUGIN_WORKBENCH_CONTENT_PANEL_ID]:
						layout[PLUGIN_WORKBENCH_CONTENT_PANEL_ID] ?? current[PLUGIN_WORKBENCH_CONTENT_PANEL_ID],
					[PLUGIN_WORKBENCH_DOCK_PANEL_ID]:
						layout[PLUGIN_WORKBENCH_DOCK_PANEL_ID] ?? current[PLUGIN_WORKBENCH_DOCK_PANEL_ID],
				}),
			)
		},
		[setVerticalLayout],
	)

	useEffect(() => {
		if (!rightPaneVisible) return
		const next = horizontalLayout
		const current = horizontalGroupRef.current?.getLayout()
		if (!current || !hasSameLayout(current, next)) {
			horizontalGroupRef.current?.setLayout(next)
		}
	}, [horizontalLayout, rightPaneVisible])

	useEffect(() => {
		if (!dockVisible) return
		const next = verticalLayout
		const current = verticalGroupRef.current?.getLayout()
		if (!current || !hasSameLayout(current, next)) {
			verticalGroupRef.current?.setLayout(next)
		}
	}, [dockVisible, verticalLayout])

	return (
		<PluginWorkbenchAsideProvider value={asideContext}>
			<div className="plx-pluginWorkbench">
				<PanelGroup
					key={horizontalGroupKey}
					className="plx-pluginWorkbench__horizontal"
					id="pluxel-plugin-workbench-horizontal"
					groupRef={horizontalGroupRef}
					orientation="horizontal"
					defaultLayout={
						rightPaneVisible
							? horizontalLayout
							: {
									[PLUGIN_WORKBENCH_MAIN_PANEL_ID]: 100,
								}
					}
					onLayoutChanged={rightPaneVisible ? handleHorizontalLayoutChanged : undefined}
				>
					<Panel
						id={PLUGIN_WORKBENCH_MAIN_PANEL_ID}
						defaultSize={
							rightPaneVisible ? `${horizontalLayout[PLUGIN_WORKBENCH_MAIN_PANEL_ID]}%` : '100%'
						}
						minSize={rightPaneVisible ? '44%' : '100%'}
						style={PANEL_STYLE}
					>
						<PanelGroup
							key={verticalGroupKey}
							className="plx-pluginWorkbench__vertical"
							id="pluxel-plugin-workbench-vertical"
							groupRef={verticalGroupRef}
							orientation="vertical"
							defaultLayout={
								dockVisible
									? verticalLayout
									: {
											[PLUGIN_WORKBENCH_CONTENT_PANEL_ID]: 100,
										}
							}
							onLayoutChanged={dockVisible ? handleVerticalLayoutChanged : undefined}
						>
							<Panel
								id={PLUGIN_WORKBENCH_CONTENT_PANEL_ID}
								defaultSize={
									dockVisible ? `${verticalLayout[PLUGIN_WORKBENCH_CONTENT_PANEL_ID]}%` : '100%'
								}
								minSize={dockVisible ? '12%' : '100%'}
								style={PANEL_STYLE}
							>
								<div className="plx-pluginWorkbench__workspace">
									<RightPane config={config} />
								</div>
							</Panel>

							{dockVisible ? (
								<>
									<PanelSeparator className="plx-workbench__resizeHandle plx-workbench__resizeHandle--horizontal" />
									<Panel
										id={PLUGIN_WORKBENCH_DOCK_PANEL_ID}
										defaultSize={`${verticalLayout[PLUGIN_WORKBENCH_DOCK_PANEL_ID]}%`}
										minSize="8%"
										style={PANEL_STYLE}
									>
										<PluginWorkbenchPanel />
									</Panel>
								</>
							) : null}
						</PanelGroup>
					</Panel>

					{rightPaneVisible ? (
						<>
							<PanelSeparator className="plx-workbench__resizeHandle" />
							<Panel
								id={PLUGIN_WORKBENCH_ASIDE_PANEL_ID}
								defaultSize={`${horizontalLayout[PLUGIN_WORKBENCH_ASIDE_PANEL_ID]}%`}
								minSize="12%"
								style={PANEL_STYLE}
							>
								<PluginWorkbenchSidebar />
							</Panel>
						</>
					) : null}
				</PanelGroup>
			</div>
		</PluginWorkbenchAsideProvider>
	)
}
