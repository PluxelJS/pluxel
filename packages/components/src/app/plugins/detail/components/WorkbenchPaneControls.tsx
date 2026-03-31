import {
	IconLayout2,
	IconLayoutBottombarCollapse,
	IconLayoutBottombarExpand,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconLayoutSidebarRightCollapse,
	IconLayoutSidebarRightExpand,
} from '@tabler/icons-react'
import { memo, useEffect, useMemo, useRef } from 'react'
import { useWorkbenchLayout, useWorkbenchTabs } from '../../../workbench/context'
import { usePluginWorkbenchLayout } from '../workbench/context'

function PaneControlButton({
	active,
	label,
	onClick,
	children,
}: {
	active: boolean
	label: string
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			className="plx-pluginWorkbench__paneControl"
			data-active={active ? 'true' : 'false'}
			onClick={onClick}
			aria-label={label}
			title={label}
		>
			{children}
		</button>
	)
}

export const WorkbenchPaneControls = memo(function WorkbenchPaneControls() {
	const { leftPaneAvailable, leftPaneVisible, setLeftPaneVisible, toggleLeftPane } =
		useWorkbenchLayout()
	const { activeTabId } = useWorkbenchTabs()
	const {
		dockVisible,
		rightPaneVisible,
		setDockVisible,
		setRightPaneVisible,
		toggleDock,
		toggleRightPane,
	} = usePluginWorkbenchLayout()
	const focusSnapshotRef = useRef<{
		leftPaneVisible: boolean
		dockVisible: boolean
		rightPaneVisible: boolean
	} | null>(null)

	const focusMode = useMemo(
		() => leftPaneAvailable && !leftPaneVisible && !dockVisible && !rightPaneVisible,
		[dockVisible, leftPaneAvailable, leftPaneVisible, rightPaneVisible],
	)

	useEffect(() => {
		focusSnapshotRef.current = null
	}, [activeTabId])

	const toggleFocusMode = () => {
		if (focusMode) {
			const snapshot = focusSnapshotRef.current
			if (leftPaneAvailable) setLeftPaneVisible(snapshot?.leftPaneVisible ?? true)
			setDockVisible(snapshot?.dockVisible ?? true)
			setRightPaneVisible(snapshot?.rightPaneVisible ?? true)
			focusSnapshotRef.current = null
			return
		}

		focusSnapshotRef.current = {
			leftPaneVisible,
			dockVisible,
			rightPaneVisible,
		}
		if (leftPaneAvailable) setLeftPaneVisible(false)
		setDockVisible(false)
		setRightPaneVisible(false)
	}

	return (
		<div className="plx-pluginWorkbench__paneControls">
			{leftPaneAvailable ? (
				<PaneControlButton
					active={leftPaneVisible}
					label={leftPaneVisible ? '隐藏左栏' : '显示左栏'}
					onClick={toggleLeftPane}
				>
					{leftPaneVisible ? (
						<IconLayoutSidebarLeftCollapse size={18} />
					) : (
						<IconLayoutSidebarLeftExpand size={18} />
					)}
				</PaneControlButton>
			) : null}

			<PaneControlButton
				active={rightPaneVisible}
				label={rightPaneVisible ? '隐藏右栏' : '显示右栏'}
				onClick={toggleRightPane}
			>
				{rightPaneVisible ? (
					<IconLayoutSidebarRightCollapse size={18} />
				) : (
					<IconLayoutSidebarRightExpand size={18} />
				)}
			</PaneControlButton>

			<PaneControlButton
				active={dockVisible}
				label={dockVisible ? '隐藏底部日志' : '显示底部日志'}
				onClick={toggleDock}
			>
				{dockVisible ? (
					<IconLayoutBottombarCollapse size={18} />
				) : (
					<IconLayoutBottombarExpand size={18} />
				)}
			</PaneControlButton>

			<PaneControlButton
				active={focusMode}
				label={focusMode ? '恢复周边面板' : '聚焦工作区'}
				onClick={toggleFocusMode}
			>
				<IconLayout2 size={18} />
			</PaneControlButton>
		</div>
	)
})
